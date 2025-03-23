const limits = (maxConcurrent) => {

    const fns = [];
    let running = 0;

    const limit = (shift, fn) => new Promise((resolve) => {

        const run = async () => {
            fns.splice(fns.indexOf(run), 1);
            running++;
            clearTimeout(timeout);
            resolve(await fn());
            running--;
            if (fns.length > 0) fns[0]();
        };
        const timeout = setTimeout(run, shift);

        if (running < maxConcurrent) run();
        else fns.push(run);
    });

    return limit;
};

const splitEmbed = (embed) => {

    const lines = embed.description.split("\n").map((line) => line = line.length > 4096 ? line.slice(0, 4093) + "..." : line);

    const descriptions = [[]];
    for (const line of lines) {
        const description = descriptions[descriptions.length - 1];
        if (description.concat(line).join("\n").length > 4096) descriptions.push([line]);
        else description.push(line);
    }

    const embeds = [];
    for (const description of descriptions) embeds.push({ description: description.join("\n"), color: embed.color });

    embeds[0].title = embed.title;
    embeds[embeds.length - 1].timestamp = embed.timestamp;
    embeds[embeds.length - 1].footer = embed.footer;

    return embeds;
};

const alert = (message) => new Promise((resolve, reject) => {
    fetch(process.env.ALERT_DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message)
    }).then((res) => {
        if (res.ok) resolve();
        else res.text().then((text) => reject(text));
    }).catch((error) => reject(error.toString()));
});

const pingSessions = [];
const genPingSessionId = () => {
    let sessionId = process.pid;
    while (pingSessions.includes(sessionId % 65535)) sessionId++;
    sessionId %= 65535;
    pingSessions.push(sessionId);
    return sessionId;
};
const releasePingSessionId = (sessionId) => setTimeout(() => pingSessions.splice(pingSessions.indexOf(sessionId), 1), 30 * 1000);

const median = (values) => {

    if (values.length === 0)
        throw new Error("Input array is empty");

    // Sorting values, preventing original array from being mutated.
    values = [...values].sort((a, b) => a - b);

    const half = Math.floor(values.length / 2);
    return (values.length % 2
        ? values[half]
        : (values[half - 1] + values[half]) / 2
    );
}

module.exports = { limits, alert, splitEmbed, genPingSessionId, releasePingSessionId, median };
