const { request: httpsRequest } = require("https");
const { request: httpRequest } = require("http");
const { pingWithPromise } = require("minecraft-ping-js");
const Ws = require("ws");

const checkWebsite = (host) =>
    new Promise((resolve, reject) => {
        let finishDate = 0;
        let responseDate = 0;

        const req = (host.startsWith("https") ? httpsRequest : httpRequest)(host, { agent: false });
        req.on("socket", (socket) => {
            socket.on("connect", () => (finishDate = process.hrtime.bigint()));
            socket.on("secureConnect", () => (finishDate = process.hrtime.bigint()));
        });
        req.on("response", (res) => {
            responseDate = process.hrtime.bigint();
            res.on("data", () => {});
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

const checkApi = (host) =>
    new Promise((resolve, reject) => {
        let finishDate = 0;
        let responseDate = 0;

        const req = (host.startsWith("https") ? httpsRequest : httpRequest)(host, { agent: false });
        req.on("socket", (socket) => {
            socket.on("connect", () => (finishDate = process.hrtime.bigint()));
            socket.on("secureConnect", () => (finishDate = process.hrtime.bigint()));
        });
        req.on("response", (res) => {
            responseDate = process.hrtime.bigint();
            let data = "";
            res.on("data", (chunk) => (data += chunk));
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

const checkWs = (host) =>
    new Promise((resolve, reject) => {
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

const checkMinecraft = (host) =>
    new Promise((resolve, reject) => {
        pingWithPromise(host.split(":")[0], parseInt(host.split(":")[1]) || 25565)
            .then((res) => resolve(res.ping))
            .catch((error) => reject(error));

        // Timeout of 10s is handled by the library
    });

module.exports = {
    checkWebsite,
    checkApi,
    checkWs,
    checkMinecraft
};
