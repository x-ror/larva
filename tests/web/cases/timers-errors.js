// setTimeout and setInterval with no argument at all throw the binding's arity
// TypeError (the handler is required); clearTimeout/clearInterval take an optional id
// and return quietly.
const attempt = (label, f) => {
  try {
    f();
    print(label + ': no throw');
  } catch (e) {
    print(label + ': ' + e.constructor.name + ': ' + e.message);
  }
};
attempt('setTimeout()', () => setTimeout());
attempt('setInterval()', () => setInterval());
attempt('clearTimeout()', () => clearTimeout());
attempt('clearInterval()', () => clearInterval());
