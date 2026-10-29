// supabase/functions/_shared/protoShim.ts
//
// fontkit (used by billPdf.ts) is compiled with Babel, which sets up class
// inheritance with `Sub.__proto__ = Super`. Browsers and Node support that;
// Deno - the runtime of the edge functions - deliberately leaves the
// __proto__ accessor out, so those classes silently lose their inherited
// static methods and shaping Devanagari text (Hindi names on a bill) fails.
// This restores the standard accessor where it is missing; anywhere it
// already exists (every browser) it does nothing. It must be imported before
// fontkit.
if (!Object.getOwnPropertyDescriptor(Object.prototype, '__proto__')) {
  Object.defineProperty(Object.prototype, '__proto__', {
    configurable: true,
    enumerable: false,
    get(this: object) {
      return Object.getPrototypeOf(this);
    },
    set(this: object, proto: unknown) {
      if ((typeof proto === 'object' || typeof proto === 'function') && Object.isExtensible(this)) {
        Object.setPrototypeOf(this, proto as object | null);
      }
    },
  });
}

export {};
