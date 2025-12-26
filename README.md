# @kurkle/configs

Shared configuration files for projects.

## Installation

Install this package as a dev dependency in your project:

```bash
npm install --save-dev @kurkle/configs
```

## Usage

To use these configurations in your project, create or update your `biome.json` file to extend this config:

```json
{
  "extends": ["./node_modules/@kurkle/configs/biome.json"]
}
```

This will inherit all the linter rules, formatter settings, and assist actions defined in this package.

## Configuration Overview

### Linter Rules
- **Recommended rules**: Enabled
- **Complexity**: Warns if cognitive complexity exceeds 10
- **Correctness**: Errors for unused imports and variables
- **Suspicious**: `noExplicitAny` and `noRedeclare` turned off
- **Performance**: `noDelete` turned off
- **Style**: Enforces `useImportType`

### Code Assist
- **Source actions**: Sorting keys, attributes, properties enabled
- **Organize imports**: Enabled with specific grouping (types, packages, paths)

### Formatter
- **Indentation**: 2 spaces
- **Line width**: 100 characters
- **Quote style**: Single quotes
- **Trailing commas**: ES5 style
- **Semicolons**: As needed
- **Globals**: Browser, Node, Jasmine

### JavaScript
- Inherits formatter settings with single quotes, ES5 trailing commas, and semicolons as needed
- Globals: browser, node, jasmine

## Contributing

If you need to modify these configs, update the `biome.json` file in this repository and publish a new version.

## License

This project is licensed under the MIT License.