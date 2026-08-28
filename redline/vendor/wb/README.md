# Vendored Workbench color picker

These files were copied without modification from the Workbench component
library at commit `618447f4324dd17e0a34a5a6b01f88a7822a57b1`:

- `src/wb-base.js`
- `src/define-element.js`
- `src/wb-color-picker/wb-color-picker.js`
- `src/wb-color-picker/wb-color-picker.resources.js`
- `src/wb-color-picker/wb-color-picker.define.js`

Keeping the dependency inside the Redline directory makes the package work when
copied to another project and avoids a runtime dependency on another checkout.
