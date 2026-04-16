const isCloud = process.argv.includes("--cloud") || process.env.LODIS_CLOUD === "1";
const isServe = process.argv.includes("--serve") || process.env.LODIS_SERVE === "1";

if (isCloud) {
  import("./cloud.js").then(({ startCloudServer }) => startCloudServer());
} else if (isServe) {
  import("./serve.js").then(({ startServeMode }) => startServeMode());
} else {
  import("./server.js").then(({ startServer }) => startServer());
}
