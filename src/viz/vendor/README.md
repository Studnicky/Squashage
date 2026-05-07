# Vendored cytoscape.js Bundle

`cytoscapeBundle.ts` exports the full cytoscape.js minified bundle as a
TypeScript `string` constant. It is inlined into the rendered HTML by
`GraphRenderer.render`. No runtime import of the `cytoscape` npm package
occurs in production code.

## Pinned Version

See the `@Pinned version` comment at the top of `cytoscapeBundle.ts`.

## Refreshing

```bash
# Ensure cytoscape devDependency is installed:
npm install

# Refresh the bundle to the currently installed version:
npm run viz:refresh-vendor
```

The refresh script (`scripts/refresh-viz-vendor.js`) reads
`node_modules/cytoscape/dist/cytoscape.min.js`, escapes backticks and
backslashes for TypeScript template literal embedding, and overwrites
`cytoscapeBundle.ts` with the new version comment and bundle content.

To pin a specific version:

```bash
npm install --save-dev cytoscape@3.30.4
npm run viz:refresh-vendor
```

## License

cytoscape.js is MIT licensed.
Source: https://github.com/cytoscape/cytoscape.js
