// src/latex-math.js — turns the LaTeX MathQuill emits into something the
// grapher can evaluate.
//
// This is deliberately a parser for MathQuill's dialect, not for LaTeX at
// large. MathQuill's output is regular and small: \frac{}{}, \sqrt{} and
// \sqrt[]{}, ^{} and _{}, \left( … \right) with ( [ { | as delimiters,
// \sin-style built-in operator names, \operatorname{} for the rest, \cdot,
// \pi, e, \infty, single-letter variables with implicit multiplication
// ("2x", "x\sin x"). Anything outside that set is reported as an error
// with a message the graph panel can show, rather than silently graphing
// something else. No library does this job for LaTeX input directly, and
// the ones that come close are hundreds of kilobytes, so it's ~300 lines
// of our own.
//
// Public surface: window.LatexMath.compileEquation(latex) returns
//   { kind: 'y',        f: (x) => y,       label }   for y = f(x) and bare expressions
//   { kind: 'x',        f: (y) => x,       label }   for x = g(y)
//   { kind: 'implicit', f: (x, y) => F,    label }   for anything else with '=' (F = 0 on the curve)
// or throws an Error whose message is meant for the user.
//
// Expressions compile to closures (x, y) => number rather than generated
// source, because the app's CSP forbids eval/new Function — and closures
// are plenty fast for a few thousand samples per frame.

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
        // Spacing commands (, ; quad, " ") change nothing here; drop them
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
  // node: a closure (x, y) => number, with the flags usesX / usesY attached
  // so the equation classifier can tell y = f(x) apart from x = g(y).
  class Parser {
    constructor(tokens) {
      this.t = tokens;
      this.i = 0;
      this.usesX = false;
      this.usesY = false;
    }

    peek(offset = 0) { return this.t[this.i + offset]; }
    next() { return this.t[this.i++]; }
    atEnd() { return this.i >= this.t.length; }
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
        if (this.is('sym', '+')) { this.next(); const r = this.parseProduct(); const l = left; left = (x, y) => l(x, y) + r(x, y); }
        else if (this.is('sym', '-')) { this.next(); const r = this.parseProduct(); const l = left; left = (x, y) => l(x, y) - r(x, y); }
        else return left;
      }
    }

    // product := unary (('*' | '/' | juxtaposition) unary)*
    // Juxtaposition is implicit multiplication: "2x", "x\sin x", "(x+1)(x-1)".
    parseProduct() {
      let left = this.parseUnary();
      for (;;) {
        if (this.is('cmd', 'cdot') || this.is('cmd', 'times') || this.is('sym', '*')) {
          this.next(); const r = this.parseUnary(); const l = left; left = (x, y) => l(x, y) * r(x, y);
        } else if (this.is('cmd', 'div') || this.is('sym', '/')) {
          this.next(); const r = this.parseUnary(); const l = left; left = (x, y) => l(x, y) / r(x, y);
        } else if (this.startsFactor()) {
          const r = this.parseUnary(); const l = left; left = (x, y) => l(x, y) * r(x, y);
        } else return left;
      }
    }

    // unary := ('-' | '+') unary | postfix
    parseUnary() {
      if (this.is('sym', '-')) { this.next(); const inner = this.parseUnary(); return (x, y) => -inner(x, y); }
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
        base = (x, y) => Math.pow(b(x, y), exp(x, y));
      }
      return base;
    }

    // The thing after ^ or _ : a braced group, or a single token.
    parseExponent() {
      if (this.is('sym', '{')) return this.parseGroup();
      if (this.is('sym', '-')) { this.next(); const inner = this.parseExponent(); return (x, y) => -inner(x, y); }
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
        if (IGNORED.has(tok.value) || tok.value === 'right' || RELATIONS.has(tok.value)) return false;
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
          return (x, y) => Math.abs(inner(x, y));
        }
        throw new Error(`Unexpected ${this.describe(tok)}`);
      }

      // Commands.
      this.next();
      const name = tok.value;
      if (IGNORED.has(name)) return this.parseFactor();
      if (name === 'left') return this.parseDelimited();
      if (name === 'frac') { const n = this.parseGroup(); const d = this.parseGroup(); return (x, y) => n(x, y) / d(x, y); }
      if (name === 'sqrt') return this.parseRoot();
      if (name === 'operatorname') {
        this.expect('sym', '{', '"{"');
        let fname = '';
        while (!this.is('sym', '}')) { const t = this.next(); if (!t) throw new Error('Unclosed \\operatorname'); fname += t.value; }
        this.next();
        return this.parseFunction(fname);
      }
      if (FUNCTIONS[name]) return this.parseFunction(name);
      if (CONSTANTS[name] !== undefined) { const v = CONSTANTS[name]; return () => v; }
      if (name === 'text') throw new Error('Text can\'t be graphed');
      if (RELATIONS.has(name)) throw new Error('Inequalities aren\'t graphed yet');
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
      if (name === 'x') { this.usesX = true; return (x) => x; }
      if (name === 'y') { this.usesY = true; return (x, y) => y; }
      if (name === 'e') return () => Math.E;
      throw new Error(`Unknown variable "${name}" — only x and y can be graphed`);
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
      return isAbs ? (x, y) => Math.abs(inner(x, y)) : inner;
    }

    parseRoot() {
      if (this.is('sym', '[')) {
        this.next();
        const degree = this.parseSum();
        this.expect('sym', ']', '"]"');
        const radicand = this.parseGroup();
        return (x, y) => nthRoot(radicand(x, y), degree(x, y));
      }
      const radicand = this.parseGroup();
      return (x, y) => Math.sqrt(radicand(x, y));
    }

    // A named function, optionally with ^{n} (power of the result, or ^{-1}
    // for the inverse) and _{b} (log base), then its argument. A
    // parenthesised argument is exactly that; an unparenthesised one is the
    // following run of implicitly-multiplied factors, so "\sin 2x" is
    // sin(2x) and "\sin x\cos x" is sin(x)·cos(x) — the argument stops at
    // the next function name, operator or sign.
    parseFunction(name) {
      let fn = FUNCTIONS[name];
      if (!fn) throw new Error(`Unknown function "${name}"`);
      let power = null;
      let base = null;
      for (;;) {
        if (this.is('sym', '^')) {
          this.next();
          const expNode = this.parseExponent();
          const value = expNode(0, 0);
          if (value === -1 && INVERSES[name]) { fn = INVERSES[name]; }
          else power = expNode;
        } else if (this.is('sym', '_') && (name === 'log' || name === 'ln')) {
          this.next();
          base = this.parseExponent();
        } else break;
      }
      const arg = this.parseFunctionArgument();
      let apply;
      if (base) apply = (x, y) => Math.log(arg(x, y)) / Math.log(base(x, y));
      else apply = (x, y) => fn(arg(x, y));
      if (power) { const p = power; const inner = apply; apply = (x, y) => Math.pow(inner(x, y), p(x, y)); }
      return apply;
    }

    parseFunctionArgument() {
      // A bracketed argument is just the bracket's contents; a ^ after it
      // is left for parsePostfix to apply to the function's result, so
      // \sin\left(x\right)^{2} is (sin x)², as anyone typing it means.
      if (this.is('sym', '(') || this.is('sym', '[') || this.is('cmd', 'left') || this.is('sym', '{')) {
        return this.parseFactor();
      }
      if (this.is('sym', '-')) { this.next(); const inner = this.parseFunctionArgument(); return (x, y) => -inner(x, y); }
      if (!this.startsFactor()) throw new Error('A function needs an argument');
      let left = this.parsePostfix();
      while (this.startsFactor() && !this.nextIsFunction()) {
        const r = this.parsePostfix(); const l = left; left = (x, y) => l(x, y) * r(x, y);
      }
      return left;
    }

    nextIsFunction() {
      const tok = this.peek();
      return !!tok && tok.type === 'cmd' && (FUNCTIONS[tok.value] !== undefined || tok.value === 'operatorname');
    }
  }

  function nthRoot(v, n) {
    if (n === 2) return Math.sqrt(v);
    if (n === 3) return Math.cbrt(v);
    // Odd integer roots of negatives are real.
    if (v < 0 && Number.isInteger(n) && n % 2 === 1) return -Math.pow(-v, 1 / n);
    return Math.pow(v, 1 / n);
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

  function compileEquation(latex) {
    const tokens = tokenize(latex);
    if (tokens.length === 0) throw new Error('Nothing to graph');
    for (const t of tokens) {
      if (t.type === 'cmd' && RELATIONS.has(t.value)) throw new Error('Inequalities aren\'t graphed yet');
      if (t.type === 'sym' && (t.value === '<' || t.value === '>')) throw new Error('Inequalities aren\'t graphed yet');
    }
    const eqs = tokens.map((t, i) => (t.type === 'sym' && t.value === '=' ? i : -1)).filter((i) => i >= 0);
    if (eqs.length > 1) throw new Error('Only one "=" per graph');

    if (eqs.length === 0) {
      const e = compile(tokens);
      if (e.usesY) throw new Error('Write it as an equation ("… = …") to graph a relation in x and y');
      return { kind: 'y', f: (x) => e.f(x, 0), label: 'y = ' + latex };
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
      if (kind === 'y' && !e.usesY) return { kind: 'y', f: (x) => e.f(x, 0), label: latex };
      if (kind === 'x' && !e.usesX) return { kind: 'x', f: (y) => e.f(0, y), label: latex };
      return null;
    };
    const explicit = tryExplicit(lhsTokens, rhsTokens) || tryExplicit(rhsTokens, lhsTokens);
    if (explicit) return explicit;

    const lhs = compile(lhsTokens);
    const rhs = compile(rhsTokens);
    if (!lhs.usesX && !lhs.usesY && !rhs.usesX && !rhs.usesY) throw new Error('Neither side uses x or y');
    return { kind: 'implicit', f: (x, y) => lhs.f(x, y) - rhs.f(x, y), label: latex };
  }

  window.LatexMath = { compileEquation, tokenize };
})();
