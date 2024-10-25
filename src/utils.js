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

module.exports = { limits, alert };
