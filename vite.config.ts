// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Modified for Mail App, 2026: added LOCAL_ONLY mode (see README); a build stamp shared by the app and
// the Worker, so an app window left open across an update knows to reload.

import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  define: {
    __APP_BUILD__: JSON.stringify(process.env.APP_BUILD || new Date().toISOString()),
  },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // LOCAL_ONLY=1 runs without a Cloudflare login: remote bindings
      // (send_email) are simulated locally instead of proxied.
      remoteBindings: !process.env.LOCAL_ONLY,
    }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
