---
"json-patch-to-crdt": patch
---

Add optional runtime JSON guardrails for untyped inputs across `createState`, patch application/validation, and `diffJsonPatch` via `jsonValidation: "none" | "strict" | "normalize"`.

Introduce strict runtime rejection for non-JSON values (for example `NaN`, `Infinity`, and `undefined`) and a normalize mode that coerces non-finite numbers/invalid array items to `null` while omitting invalid object-property values.

Export `JsonValueValidationError`, document strict-vs-lenient behavior in the README, and add regression coverage for strict and normalize modes.
