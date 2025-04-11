const { request: httpsRequest } = require("https");
const { request: httpRequest } = require("http");
const { pingWithPromise } = require("minecraft-ping-js");
const Ws = require("ws");
const net = require("net");
const ping = require("net-ping");

const v4session = new ping.Session({
    sessionId: process.pid + 1,
    networkProtocol: ping.NetworkProtocol.IPv4,
    timeout: 1000,
    packetSize: 64,
    ttl: 64,
    retries: 4
});

const v6session = new ping.Session({
    sessionId: process.pid + 1,
    networkProtocol: ping.NetworkProtocol.IPv6,
    timeout: 1000,
    packetSize: 64,
    ttl: 64,
    retries: 4
});

const checkServer = (host) => new Promise((resolve, reject) => {
    const session = net.isIPv4(host) ? v4session : v6session;
    session.pingHost(host, (error, _target, sent, rcvd) => {
        if (error) reject(error);
        else resolve(Number(rcvd - sent) / 1000);
    });
});

const checkWebsite = (host) => new Promise((resolve, reject) => {

    let finishDate = 0;
    let responseDate = 0;

    const req = (host.startsWith("https") ? httpsRequest : httpRequest)(host, { agent: false });
    req.on("socket", (socket) => {
        socket.on("connect", () => finishDate = process.hrtime.bigint());
        socket.on("secureConnect", () => finishDate = process.hrtime.bigint());
    });
    req.on("response", (res) => {
        responseDate = process.hrtime.bigint();
        res.on("data", () => { });
        res.on("end", () => {

            if (res.statusCode !== 200) {
                reject("Status code (" + res.statusCode + ") is not 200");
                return;
            }

            resolve(Number(responseDate - finishDate) / 1000000);
        });
    });
    req.on("error", (error) => reject(error));
    req.end();

    setTimeout(() => reject(new Error("timeout")), 10000);
});

const checkApi = (host) => new Promise((resolve, reject) => {

    let finishDate = 0;
    let responseDate = 0;

    const req = (host.startsWith("https") ? httpsRequest : httpRequest)(host, { agent: false });
    req.on("socket", (socket) => {
        socket.on("connect", () => finishDate = process.hrtime.bigint());
        socket.on("secureConnect", () => finishDate = process.hrtime.bigint());
    });
    req.on("response", (res) => {
        responseDate = process.hrtime.bigint();
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {

            try {
                JSON.parse(data);
            } catch (error) {
                reject("Invalid JSON");
                return;
            }

            resolve(Number(responseDate - finishDate) / 1000000);
        });
    });
    req.on("error", (error) => reject(error));
    req.end();

    setTimeout(() => reject(new Error("timeout")), 10000);
});

const checkWs = (host) => new Promise((resolve, reject) => {

    let openTime = -1;

    const ws = new Ws(host);

    ws.on("open", () => {
        openTime = process.hrtime.bigint();
        ws.send("");
    });

    ws.on("close", () => {
        const endTime = process.hrtime.bigint();
        if (openTime > 0) resolve(Number(endTime - openTime) / 1000000);
    });

    ws.on("error", (error) => reject(error));

    setTimeout(() => reject(new Error("timeout")), 10000);
});

const checkBot = (host) => new Promise((resolve, reject) => {

    fetch(host).then((res) => {

        if (res.status !== 200) {
            reject("Check failed");
            return;
        }

        res.json().then((json) => {

            if (json.online) resolve();
            else reject("Bot offline");

        }).catch(() => reject("Check failed"));

    }).catch(() => reject("Check failed"));

    setTimeout(() => reject("Check failed"), 10000);
});

const checkMinecraft = (host) => new Promise((resolve, reject) => {

    pingWithPromise(host.split(":")[0], parseInt(host.split(":")[1]) || 25565)
        .then((res) => resolve(res.ping))
        .catch((error) => reject(error));

    // Timeout of 10s is handled by the library
});

module.exports = {
    checkServer,
    checkWebsite,
    checkApi,
    checkWs,
    checkBot,
    checkMinecraft
};
