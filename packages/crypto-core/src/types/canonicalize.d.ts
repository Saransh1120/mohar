// The published .d.ts for "canonicalize" declares `export default function`,
// but the package is plain CommonJS (`module.exports = function`) with no
// "type": "module". Under NodeNext that mismatch resolves the import to the
// module namespace object instead of the function, so `canonicalize(...)` is
// "not callable". `export =` matches the actual runtime shape.
declare module "canonicalize" {
  function canonicalize(input: unknown): string | undefined;
  export = canonicalize;
}
