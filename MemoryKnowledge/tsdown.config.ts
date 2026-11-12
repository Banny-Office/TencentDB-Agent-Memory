import { defineConfig } from "tsdown";
import packageJson from "./package.json" with { type: "json" };

function collectExternalDependencies(): string[] {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ];
}

export default defineConfig({
  entry: { server: "./src/server.ts", "mcp/server": "./src/mcp/server.ts", "index-worker": "./src/engines/wiki/index-worker.ts" },
  outDir: "./dist",
  format: "esm",
  platform: "node",
  clean: true,
  fixedExtension: true,
  dts: false,
  sourcemap: false,
  deps: {
    neverBundle: (id) => {
      if (id.startsWith("node:")) return true;
      for (const dep of collectExternalDependencies()) {
        if (id === dep || id.startsWith(`${dep}/`)) return true;
      }
      return false;
    },
  },
});
