import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
let input = ""; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input), file = request.mcpServers.h2_station.env.H2_STATION_CONNECTION;
const connection = JSON.parse(fs.readFileSync(file, "utf8"));
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
fs.writeFileSync(path.join(process.cwd(), "cancel-observed.json"), JSON.stringify({ pid: process.pid, childPid: grandchild.pid, file, ...connection }));
process.stderr.write(connection.token); // H2 must not forward vendor diagnostics.
setInterval(() => {}, 1000);
