---
"json-patch-to-crdt": patch
---

Extend `crdtToJsonPatch` with a CRDT-native sequence diff path that trims unchanged array prefixes and suffixes before materializing only the edited window, and add a regression test covering localized array edits around unchanged cyclic shared elements.
