const { request: httpsRequest } = require("https");
const { request: httpRequest } = require("http");
const { pingWithPromise } = require("minecraft-ping-js");
const Ws = require("ws");
const ping = require("net-ping");

const checkServer = (host) => new Promise((resolve, reject) => {

    const session = ping.createSession();
    session.pingHost(host, (error) => {
        if (error) reject(error);
        else {
            const date = Date.now();
            session.pingHost(host, (error) => {
                if (error) reject(error);
                else resolve(Date.now() - date);
            });
        }
    });
});

const checkWebsite = (host) => new Promise((resolve, reject) => {

    let finishDate = 0;
    let responseDate = 0;

    const req = (host.startsWith("https") ? httpsRequest : httpRequest)(host, { agent: false });
    req.on("finish", () => finishDate = Date.now());
    req.on("response", (res) => {
        responseDate = Date.now();
        res.on("data", () => { });
        res.on("end", () => {

            if (res.statusCode !== 200) {
                reject("Status code (" + res.statusCode + ") is not 200");
                return;
            }

            resolve(responseDate - finishDate);
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
    req.on("finish", () => finishDate = Date.now());
    req.on("response", (res) => {
        responseDate = Date.now();
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {

            try {
                JSON.parse(data);
            } catch (error) {
                reject("Invalid JSON");
                return;
            }

            resolve(responseDate - finishDate);
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
        openTime = Date.now();
        ws.send("");
    });

    ws.on("close", () => {
        if (openTime > 0) resolve(Date.now() - openTime);
    });

    ws.on("error", (error) => {
        reject(error);
    });

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
}
