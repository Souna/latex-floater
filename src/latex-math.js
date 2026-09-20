// src/latex-math.js — turns the LaTeX MathQuill emits into something the
// app can evaluate: a function to graph, or a number to display.
//
// This is deliberately a parser for MathQuill's dialect, not for LaTeX at
// large. MathQuill's output is regular and small: \frac{}{}, \sqrt{} and
// \sqrt[]{}, ^{} and _{}, \left( … \right) with ( [ { | as delimiters,
// \sin-style built-in operator names, \operatorname{} for the rest, \cdot,
// \pi, e, \infty, single-letter variables with implicit multiplication
// ("2x", "x\sin x"), and the big operators \int_a^b … dx, \sum_{n=a}^{b} …,
// \prod_{n=a}^{b} …. Anything outside that set is reported as an error
// with a message the UI can show, rather than silently computing something
// else. No library does this job for LaTeX input directly, and the ones
// that come close are hundreds of kilobytes, so it's ~450 lines of our own.
//
// Public surface (window.LatexMath):
//   compileEquation(latex) → { kind: 'y', f: (x) => y, label }     y = f(x), bare expressions in x
//                            { kind: 'x', f: (y) => x, label }     x = g(y)
//                            { kind: 'implicit', f: (x, y) => F }  anything else with '='
//                            or throws an Error meant for the user.
//   evaluate(latex)        → a number when the input is a closed expression
//                            (no '=' and no free x or y), else null;
//                            throws for input that doesn't parse at all.
//
// Expressions compile to closures (x, y, env) => number rather than
// generated source, because the app's CSP forbids eval/new Function — and
// closures are plenty fast for a few thousand samples per frame. `env`
// carries variables bound by an enclosing integral, sum or product; a
// bound name shadows x and y, so "\int_0^1 x\,dx" integrates over x rather
// than reading the graph's x.

(function () {
  'use strict';

  const FUNCTIONS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    cot: (v) => 1 / Math.tan(v), sec: (v) => 1 / Math.cos(v), csc: (v) => 1 / Math.sin(v),
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    ln: Math.log, log: Math.log10, exp: Math.exp, abs: Math.abs, sqrt: Math.sqrt,
    floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign
  };
  // \sin^{-1} means arcsin, not 1/sin.
  const INVERSES = {
    sin: Math.asin, cos: Math.acos, tan: Math.atan,
    sinh: Math.asinh, cosh: Math.acosh, tanh: Math.atanh
  };
  const CONSTANTS = { pi: Math.PI, e: Math.E, infty: Infinity };
  // Commands that only affect spacing/typesetting and mean nothing here.
  const IGNORED = new Set([' ', ',', ';', '!', ':', 'quad', 'qquad', 'displaystyle']);
  const RELATIONS = new Set(['<', '>', 'le', 'ge', 'leq', 'geq', 'ne', 'neq', 'lt', 'gt']);
  const OPEN_DELIMS  = new Set(['(', '[', '{', '|', 'lbrace', 'langle', 'lvert', '.']);
  const CLOSE_DELIMS = new Set([')', ']', '}', '|', 'rbrace', 'rangle', 'rvert', '.']);
  const EMPTY = Object.freeze({});

  // ---------------------------------------------------------------- tokens

  function tokenize(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '\\') {
        let j = i + 1;
        if (j < src.length && /[a-zA-Z]/.test(src[j])) {
          while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
        } else {
          j++;   // one-character command such as "\ " or "\{"
        }
        const value = src.slice(i + 1, j);
        // Spacing commands (\, \; \quad "\ ") change nothing here; drop them
        // now so no later rule has to know they exist.
        if (!IGNORED.has(value)) tokens.push({ type: 'cmd', value });
        i = j;
        continue;
      }
      if (/[0-9.]/.test(c)) {
        let j = i;
        while (j < src.length && /[0-9.]/.test(src[j])) j++;
        const text = src.slice(i, j);
        if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) throw new Error(`"${text}" isn't a number`);
        tokens.push({ type: 'num', value: parseFloat(text) });
        i = j;
        continue;
      }
      if (/[a-zA-Z]/.test(c)) { tokens.push({ type: 'var', value: c }); i++; continue; }
      tokens.push({ type: 'sym', value: c });
      i++;
    }
    return tokens;
  }

  // ---------------------------------------------------------------- parser

  // Recursive descent over the token array. Every parse function returns a
  // node: a closure (x, y, env) => number. The parser also records whether
  // the free variables x and y were used, so the equation classifier can
  // tell y = f(x) apart from x = g(y), and keeps a scope of names bound by
  // enclosing big operators. `end` bounds the tokens a sub-parse may see —
  // an integrand stops at its differential that way.
  class Parser {
    constructor(tokens) {
      this.t = tokens;
      this.i = 0;
      this.end = tokens.length;
      this.usesX = false;
      this.usesY = false;
      this.scope = [];
    }

    peek() { return this.i < this.end ? this.t[this.i] : undefined; }
    next() { return this.t[this.i++]; }
    atEnd() { return this.i >= this.end; }
    is(type, value) {
      const tok = this.peek();
      return !!tok && tok.type === type && (value === undefined || tok.value === value);
    }
    expect(type, value, what) {
      if (!this.is(type, value)) throw new Error(`Expected ${what || value} but found ${this.describe(this.peek())}`);
      return this.next();
    }
    describe(tok) {
      if (!tok) return 'the end of the expression';
      if (tok.type === 'cmd') return '\\' + tok.value;
      return `"${tok.value}"`;
    }

    parseAll() {
      const node = this.parseSum();
      if (!this.atEnd()) throw new Error(`Unexpected ${this.describe(this.peek())}`);
      return node;
    }

    // sum := product (('+' | '-') product)*
    parseSum() {
      let left = this.parseProduct();
      for (;;) {
        if (this.is('sym', '+')) { this.next(); const r = this.parseProduct(); const l = left; left = (x, y, e) => l(x, y, e) + r(x, y, e); }
        else if (this.is('sym', '-')) { this.next(); const r = this.parseProduct(); const l = left; left = (x, y, e) => l(x, y, e) - r(x, y, e); }
        else return left;
      }
    }

    // product := unary (('*' | '/' | juxtaposition) unary)*
    // Juxtaposition is implicit multiplication: "2x", "x\sin x", "(x+1)(x-1)".
    parseProduct() {
      let left = this.parseUnary();
      for (;;) {
        if (this.is('cmd', 'cdot') || this.is('cmd', 'times') || this.is('sym', '*')) {
          this.next(); const r = this.parseUnary(); const l = left; left = (x, y, e) => l(x, y, e) * r(x, y, e);
        } else if (this.is('cmd', 'div') || this.is('sym', '/')) {
          this.next(); const r = this.parseUnary(); const l = left; left = (x, y, e) => l(x, y, e) / r(x, y, e);
        } else if (this.startsFactor()) {
          const r = this.parseUnary(); const l = left; left = (x, y, e) => l(x, y, e) * r(x, y, e);
        } else return left;
      }
    }

    // unary := ('-' | '+') unary | postfix
    parseUnary() {
      if (this.is('sym', '-')) { this.next(); const inner = this.parseUnary(); return (x, y, e) => -inner(x, y, e); }
      if (this.is('sym', '+')) { this.next(); return this.parseUnary(); }
      return this.parsePostfix();
    }

    // postfix := factor ('^' exponent)*
    parsePostfix() {
      let base = this.parseFactor();
      while (this.is('sym', '^')) {
        this.next();
        const exp = this.parseExponent();
        const b = base;
        base = (x, y, e) => Math.pow(b(x, y, e), exp(x, y, e));
      }
      return base;
    }

    // The thing after ^ or _ : a braced group, or a single token.
    parseExponent() {
      if (this.is('sym', '{')) return this.parseGroup();
      if (this.is('sym', '-')) { this.next(); const inner = this.parseExponent(); return (x, y, e) => -inner(x, y, e); }
      return this.parseFactor();
    }

    parseGroup() {
      this.expect('sym', '{', '"{"');
      const node = this.parseSum();
      this.expect('sym', '}', '"}"');
      return node;
    }

    // Can the next token begin a factor? Used for implicit multiplication.
    startsFactor() {
      const tok = this.peek();
      if (!tok) return false;
      if (tok.type === 'num' || tok.type === 'var') return true;
      if (tok.type === 'sym') return tok.value === '(' || tok.value === '{' || tok.value === '[' || tok.value === '|';
      if (tok.type === 'cmd') {
        if (tok.value === 'right' || RELATIONS.has(tok.value)) return false;
        return tok.value !== 'cdot' && tok.value !== 'times' && tok.value !== 'div';
      }
      return false;
    }

    parseFactor() {
      const tok = this.peek();
      if (!tok) throw new Error('The expression ends too early');

      if (tok.type === 'num') { this.next(); const v = tok.value; return () => v; }

      if (tok.type === 'var') return this.parseVariable();

      if (tok.type === 'sym') {
        if (tok.value === '(' || tok.value === '[') {
          this.next();
          const inner = this.parseSum();
          this.expect('sym', tok.value === '(' ? ')' : ']', 'a closing bracket');
          return inner;
        }
        if (tok.value === '{') return this.parseGroup();
        if (tok.value === '|') {
          this.next();
          const inner = this.parseSum();
          this.expect('sym', '|', '"|"');
          return (x, y, e) => Math.abs(inner(x, y, e));
        }
        throw new Error(`Unexpected ${this.describe(tok)}`);
      }

      // Commands.
      this.next();
      const name = tok.value;
      if (name === 'left') return this.parseDelimited();
      if (name === 'frac') { const n = this.parseGroup(); const d = this.parseGroup(); return (x, y, e) => n(x, y, e) / d(x, y, e); }
      if (name === 'sqrt') return this.parseRoot();
      if (name === 'int') return this.parseIntegral();
      if (name === 'sum' || name === 'prod') return this.parseBigOperator(name);
      if (name === 'operatorname') {
        this.expect('sym', '{', '"{"');
        let fname = '';
        while (!this.is('sym', '}')) { const t = this.next(); if (!t) throw new Error('Unclosed \\operatorname'); fname += t.value; }
        this.next();
        return this.parseFunction(fname);
      }
      if (FUNCTIONS[name]) return this.parseFunction(name);
      // A Greek letter bound by an enclosing integral or sum ("d\theta").
      if (this.scope.includes(name)) return (x, y, env) => env[name];
      if (CONSTANTS[name] !== undefined) { const v = CONSTANTS[name]; return () => v; }
      if (name === 'text') throw new Error('Text can\'t be evaluated');
      if (RELATIONS.has(name)) throw new Error('Inequalities aren\'t supported yet');
      if (name === 'right') throw new Error('Found \\right without a matching \\left');
      // Greek letters and anything else named: a variable we don't know.
      throw new Error(`Unknown variable or command \\${name}`);
    }

    parseVariable() {
      const tok = this.next();
      let name = tok.value;
      // Subscripts make a distinct variable name ("x_1"), which is never x or y.
      if (this.is('sym', '_')) {
        this.next();
        const start = this.i;
        this.parseExponent();
        name += '_' + this.t.slice(start, this.i).map((t) => t.value).join('');
      }
      if (this.scope.includes(name)) return (x, y, env) => env[name];
      if (name === 'x') { this.usesX = true; return (x) => x; }
      if (name === 'y') { this.usesY = true; return (x, y) => y; }
      if (name === 'e') return () => Math.E;
      throw new Error(`Unknown variable "${name}" — only x and y can be used freely`);
    }

    // \left<delim> … \right<delim>. Bars mean absolute value; the rest group.
    parseDelimited() {
      const open = this.next();
      if (!open || !(OPEN_DELIMS.has(open.value))) throw new Error('\\left needs a bracket after it');
      const inner = this.parseSum();
      this.expect('cmd', 'right', '\\right');
      const close = this.next();
      if (!close || !CLOSE_DELIMS.has(close.value)) throw new Error('\\right needs a bracket after it');
      const isAbs = (open.value === '|' || open.value === 'lvert');
      return isAbs ? (x, y, e) => Math.abs(inner(x, y, e)) : inner;
    }

    parseRoot() {
      if (this.is('sym', '[')) {
        this.next();
        const degree = this.parseSum();
        this.expect('sym', ']', '"]"');
        const radicand = this.parseGroup();
        return (x, y, e) => nthRoot(radicand(x, y, e), degree(x, y, e));
      }
      const radicand = this.parseGroup();
      return (x, y, e) => Math.sqrt(radicand(x, y, e));
    }

    // A named function, optionally with ^{n} (power of the result, or ^{-1}
    // for the inverse) and _{b} (log base), then its argument. A bracketed
    // argument is exactly that — and a ^ after the bracket is left for
    // parsePostfix to apply to the function's result, so \sin\left(x\right)^{2}
    // is (sin x)² as anyone typing it means. An unbracketed argument is the
    // following run of implicitly-multiplied factors, so "\sin 2x" is
    // sin(2x) and "\sin x\cos x" is sin(x)·cos(x) — the argument stops at
    // the next function name, operator, sign, or an integral's differential.
    parseFunction(name) {
      let fn = FUNCTIONS[name];
      if (!fn) throw new Error(`Unknown function "${name}"`);
      let power = null;
      let base = null;
      for (;;) {
        if (this.is('sym', '^')) {
          this.next();
          const expNode = this.parseExponent();
          const value = expNode(0, 0, EMPTY);
          if (value === -1 && INVERSES[name]) { fn = INVERSES[name]; }
          else power = expNode;
        } else if (this.is('sym', '_') && (name === 'log' || name === 'ln')) {
          this.next();
          base = this.parseExponent();
        } else break;
      }
      const arg = this.parseFunctionArgument();
      let apply;
      if (base) apply = (x, y, e) => Math.log(arg(x, y, e)) / Math.log(base(x, y, e));
      else apply = (x, y, e) => fn(arg(x, y, e));
      if (power) { const p = power; const inner = apply; apply = (x, y, e) => Math.pow(inner(x, y, e), p(x, y, e)); }
      return apply;
    }

    parseFunctionArgument() {
      if (this.is('sym', '(') || this.is('sym', '[') || this.is('cmd', 'left') || this.is('sym', '{')) {
        return this.parseFactor();
      }
      if (this.is('sym', '-')) { this.next(); const inner = this.parseFunctionArgument(); return (x, y, e) => -inner(x, y, e); }
      if (!this.startsFactor()) throw new Error('A function needs an argument');
      let left = this.parsePostfix();
      while (this.startsFactor() && !this.nextIsFunction()) {
        const r = this.parsePostfix(); const l = left; left = (x, y, e) => l(x, y, e) * r(x, y, e);
      }
      return left;
    }

    nextIsFunction() {
      const tok = this.peek();
      return !!tok && tok.type === 'cmd' && (FUNCTIONS[tok.value] !== undefined || tok.value === 'operatorname');
    }

    // \int_{a}^{b} integrand d<var>. MathQuill writes the differential as
    // two plain letters ("dx"), which implicit multiplication would happily
    // swallow, so the differential is located first by scanning ahead —
    // the first "d" + letter at bracket depth 0 that isn't claimed by a
    // nested integral — and the integrand is parsed with `end` set to it.
    parseIntegral() {
      let lower = null, upper = null;
      for (;;) {
        if (this.is('sym', '_') && !lower) { this.next(); lower = this.parseExponent(); }
        else if (this.is('sym', '^') && !upper) { this.next(); upper = this.parseExponent(); }
        else break;
      }
      if (!lower || !upper) throw new Error('An integral needs both limits, like \\int_0^1');
      const dIdx = this.findDifferential();
      if (dIdx < 0) throw new Error('An integral needs a differential like "dx" after the integrand');
      const varName = this.t[dIdx + 1].value;
      const savedEnd = this.end;
      this.end = dIdx;
      this.scope.push(varName);
      const body = this.parseSum();
      if (!this.atEnd()) throw new Error(`Unexpected ${this.describe(this.peek())} in the integrand`);
      this.scope.pop();
      this.end = savedEnd;
      this.i = dIdx + 2;
      return (x, y, env) => integrate((t) => body(x, y, bind(env, varName, t)), lower(x, y, env), upper(x, y, env));
    }

    findDifferential() {
      let depth = 0, nested = 0;
      for (let j = this.i; j < this.end - 1; j++) {
        const tok = this.t[j];
        if (tok.type === 'sym' && (tok.value === '{' || tok.value === '(' || tok.value === '[')) depth++;
        else if (tok.type === 'sym' && (tok.value === '}' || tok.value === ')' || tok.value === ']')) depth--;
        else if (tok.type === 'cmd' && tok.value === 'left') depth++;
        else if (tok.type === 'cmd' && tok.value === 'right') depth--;
        else if (tok.type === 'cmd' && tok.value === 'int') nested++;
        else if (tok.type === 'var' && tok.value === 'd' && depth === 0 && isDifferentialName(this.t[j + 1])) {
          if (nested > 0) { nested--; j++; } else return j;
        }
      }
      return -1;
    }

    // \sum_{n=a}^{b} term and \prod_{n=a}^{b} term. The term is the product
    // that follows (up to the next + or −), as in Desmos.
    parseBigOperator(name) {
      this.expect('sym', '_', `"_" after \\${name}`);
      this.expect('sym', '{', '"{"');
      const idx = this.next();
      if (!idx || idx.type !== 'var') throw new Error(`\\${name} needs an index like n=1 in its lower limit`);
      this.expect('sym', '=', `"=" after the index of \\${name}`);
      const lower = this.parseSum();
      this.expect('sym', '}', '"}"');
      this.expect('sym', '^', `an upper limit for \\${name}`);
      const upper = this.parseExponent();
      const varName = idx.value;
      this.scope.push(varName);
      const body = this.parseProduct();
      this.scope.pop();
      const isSum = name === 'sum';
      return (x, y, env) => {
        const a = Math.ceil(lower(x, y, env)), b = Math.floor(upper(x, y, env));
        if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
        if (b - a > 1e6) return NaN;
        let acc = isSum ? 0 : 1;
        for (let k = a; k <= b; k++) {
          const v = body(x, y, bind(env, varName, k));
          acc = isSum ? acc + v : acc * v;
        }
        return acc;
      };
    }
  }

  // What may follow the "d" of a differential: a letter, or a Greek letter
  // command such as \theta (but not a function or constant).
  function isDifferentialName(tok) {
    if (!tok) return false;
    if (tok.type === 'var') return true;
    return tok.type === 'cmd' && !FUNCTIONS[tok.value] && CONSTANTS[tok.value] === undefined &&
      !['left', 'right', 'frac', 'sqrt', 'int', 'sum', 'prod', 'operatorname', 'cdot', 'times', 'div', 'text'].includes(tok.value);
  }

  // A child environment with one more binding; the prototype chain keeps
  // outer bindings visible without copying.
  function bind(env, name, value) {
    const child = Object.create(env);
    child[name] = value;
    return child;
  }

  function nthRoot(v, n) {
    if (n === 2) return Math.sqrt(v);
    if (n === 3) return Math.cbrt(v);
    // Odd integer roots of negatives are real.
    if (v < 0 && Number.isInteger(n) && n % 2 === 1) return -Math.pow(-v, 1 / n);
    return Math.pow(v, 1 / n);
  }

  // ------------------------------------------------------------ integration

  // Adaptive Gauss–Kronrod (7-point Gauss, 15-point Kronrod). All nodes are
  // interior, so integrands that blow up at an endpoint (ln x on [0, 1]) are
  // never evaluated there, and an infinite limit is folded into a finite
  // one with t = tan u. The evaluation budget keeps a pathological
  // integrand (or one re-evaluated on every keystroke) from stalling the UI.
  const GK_X = [0.991455371120813, 0.949107912342759, 0.864864423359769, 0.741531185599394,
                0.586087235467691, 0.405845151377397, 0.207784955007898];
  const GK_WK = [0.022935322010529, 0.063092092629979, 0.104790010322250, 0.140653259715525,
                 0.169004726639267, 0.190350578064785, 0.204432940075298];
  const GK_WK_CENTRE = 0.209482141084728;
  const GK_WG = [0.129484966168870, 0.279705391489277, 0.381830050505119];   // for nodes 1, 3, 5
  const GK_WG_CENTRE = 0.417959183673469;

  function integrate(f, a, b) {
    if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
    if (a === b) return 0;
    if (a > b) return -integrate(f, b, a);
    if (a === -Infinity && b === Infinity) return integrate((u) => { const t = Math.tan(u), c = Math.cos(u); return f(t) / (c * c); }, -Math.PI / 2, Math.PI / 2);
    if (b === Infinity) return integrate((u) => { const t = Math.tan(u), c = Math.cos(u); return f(a + t) / (c * c); }, 0, Math.PI / 2);
    if (a === -Infinity) return integrate((u) => { const t = Math.tan(u), c = Math.cos(u); return f(b - t) / (c * c); }, 0, Math.PI / 2);
    return gk(f, a, b, 1e-10, 40, { evals: 0 });
  }

  function gk(f, a, b, tol, depth, budget) {
    const c = (a + b) / 2, h = (b - a) / 2;
    const fc = f(c);
    let kronrod = GK_WK_CENTRE * fc, gauss = GK_WG_CENTRE * fc;
    for (let i = 0; i < 7; i++) {
      const dx = h * GK_X[i];
      const s = f(c - dx) + f(c + dx);
      kronrod += GK_WK[i] * s;
      if (i % 2 === 1) gauss += GK_WG[(i - 1) / 2] * s;
    }
    budget.evals += 15;
    kronrod *= h;
    gauss *= h;
    if (!Number.isFinite(kronrod)) return NaN;
    const err = Math.abs(kronrod - gauss);
    if (err <= tol * Math.max(1, Math.abs(kronrod)) || depth === 0 || budget.evals > 60000) return kronrod;
    return gk(f, a, c, tol / 2, depth - 1, budget) + gk(f, c, b, tol / 2, depth - 1, budget);
  }

  // ------------------------------------------------------- classification

  function stripDelims(tokens) {
    return tokens.filter((t) => !(t.type === 'cmd' && (t.value === 'left' || t.value === 'right')));
  }
  function isBareVar(tokens, name) {
    const t = stripDelims(tokens);
    return t.length === 1 && t[0].type === 'var' && t[0].value === name;
  }
  // f(x), g(x) … on the left of '=' means "graph the right side as y".
  function isFunctionOfX(tokens) {
    const t = stripDelims(tokens);
    return t.length === 4 && t[0].type === 'var' && t[0].value !== 'x' && t[0].value !== 'y' &&
      t[1].type === 'sym' && t[1].value === '(' && t[2].type === 'var' && t[2].value === 'x' &&
      t[3].type === 'sym' && t[3].value === ')';
  }

  function compile(tokens) {
    const p = new Parser(tokens);
    const f = p.parseAll();
    return { f, usesX: p.usesX, usesY: p.usesY };
  }

  // Indices of '=' at bracket depth 0: the "n=1" inside \sum_{n=1} is not
  // an equation.
  function topLevelEquals(tokens) {
    const out = [];
    let depth = 0;
    tokens.forEach((t, i) => {
      if (t.type === 'sym' && (t.value === '{' || t.value === '(' || t.value === '[')) depth++;
      else if (t.type === 'sym' && (t.value === '}' || t.value === ')' || t.value === ']')) depth--;
      else if (t.type === 'sym' && t.value === '=' && depth === 0) out.push(i);
    });
    return out;
  }

  function checkRelations(tokens) {
    for (const t of tokens) {
      if (t.type === 'cmd' && RELATIONS.has(t.value)) throw new Error('Inequalities aren\'t supported yet');
      if (t.type === 'sym' && (t.value === '<' || t.value === '>')) throw new Error('Inequalities aren\'t supported yet');
    }
  }

  function compileEquation(latex) {
    const tokens = tokenize(latex);
    if (tokens.length === 0) throw new Error('Nothing to graph');
    checkRelations(tokens);
    const eqs = topLevelEquals(tokens);
    if (eqs.length > 1) throw new Error('Only one "=" per graph');

    if (eqs.length === 0) {
      const e = compile(tokens);
      if (e.usesY) throw new Error('Write it as an equation ("… = …") to graph a relation in x and y');
      return { kind: 'y', f: (x) => e.f(x, 0, EMPTY), label: 'y = ' + latex };
    }

    const lhsTokens = tokens.slice(0, eqs[0]);
    const rhsTokens = tokens.slice(eqs[0] + 1);
    if (lhsTokens.length === 0 || rhsTokens.length === 0) throw new Error('Both sides of "=" need something');

    // "y = …", "f(x) = …", "x = …" are recognised from the tokens before
    // compiling, because "f(x)" on its own would be an unknown variable.
    const defines = (side) => (isBareVar(side, 'y') || isFunctionOfX(side)) ? 'y' : isBareVar(side, 'x') ? 'x' : null;
    const tryExplicit = (defSide, exprSide) => {
      const kind = defines(defSide);
      if (!kind) return null;
      const e = compile(exprSide);
      if (kind === 'y' && !e.usesY) return { kind: 'y', f: (x) => e.f(x, 0, EMPTY), label: latex };
      if (kind === 'x' && !e.usesX) return { kind: 'x', f: (y) => e.f(0, y, EMPTY), label: latex };
      return null;
    };
    const explicit = tryExplicit(lhsTokens, rhsTokens) || tryExplicit(rhsTokens, lhsTokens);
    if (explicit) return explicit;

    const lhs = compile(lhsTokens);
    const rhs = compile(rhsTokens);
    if (!lhs.usesX && !lhs.usesY && !rhs.usesX && !rhs.usesY) throw new Error('Neither side uses x or y');
    return { kind: 'implicit', f: (x, y) => lhs.f(x, y, EMPTY) - rhs.f(x, y, EMPTY), label: latex };
  }

  // The value of a closed expression, or null when there is nothing to
  // evaluate (an equation, or free x/y). Parse errors propagate.
  function evaluate(latex) {
    const tokens = tokenize(latex);
    if (tokens.length === 0) return null;
    if (topLevelEquals(tokens).length > 0) return null;
    checkRelations(tokens);
    const e = compile(tokens);
    if (e.usesX || e.usesY) return null;
    return e.f(0, 0, EMPTY);
  }

  window.LatexMath = { compileEquation, evaluate, tokenize };
})();
