# Import preset contribution guide

Import presets map source column names to Athlentry's canonical fields. Keep the generic templates as the default for every import kind. Add a named source-platform preset only when a real export sample has been supplied for review and the contributor can document which product, export type, and version/account configuration produced it.

## Requirements

- Never invent a source column, menu path, export capability, or record limitation. Product UI labels and export availability change.
- Do not commit customer files, personal data, credentials, financial details, or any sample containing children's information. Use a sanitized fixture containing only the original header row and synthetic rows that preserve the verified shape.
- Record the provenance of the sample in a code comment or fixture README: who verified the mapping, when, and the export type/version. Do not name an organization or retain identifying metadata.
- Presets may map only observed headers. Leave optional or uncertain fields unmapped and surface them for manual review.
- Do not make a preset choose duplicate actions, assert waiver/credential validity, or turn historical money into a charge. Imported historical payments must remain external records.
- Add a test for the exact observed headers and preserve generic manual mapping for files that do not match.

## Adding a preset

1. Get a permissioned, redacted sample from the product's normal export flow. Never request or use account credentials.
2. Verify the header row and export context with the organization that supplied the sample. Keep a sanitized fixture with synthetic row values only.
3. Add the mapping as a named adapter in the import module. Keep the generic importer and canonical fields unchanged.
4. Add tests for recognized headers, unknown headers, missing required fields, and manual mapping fallback.
5. Update the matching English and Spanish help pages only with steps and claims supported by the verified source sample.
6. Ask the import owner to review security, privacy, financial semantics, and rollback coverage before integration.
