import obsidianmd from 'eslint-plugin-obsidianmd';
export default [
  ...obsidianmd.configs.recommended,
  // This function is serialized into offline HTML and runs without Obsidian DOM extensions.
  {files: ['src/export-reader.ts'], rules: {'obsidianmd/prefer-create-el': 'off'}},
  {languageOptions: {parserOptions: {projectService: {allowDefaultProject: ['eslint.config.mjs']}}}}
];
