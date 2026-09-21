const { homedir } = require("node:os");
const path = require("node:path");

const CONFIG_DIR_NAME = ".pi-sdk-fixture";

function expandHome(directory) {
  return directory === "~" || directory.startsWith("~/")
    ? path.join(homedir(), directory.slice(2))
    : directory;
}

function getAgentDir() {
  return expandHome(
    process.env.PI_CODING_AGENT_DIR || path.join(homedir(), CONFIG_DIR_NAME, "agent"),
  );
}

module.exports = { CONFIG_DIR_NAME, getAgentDir };
