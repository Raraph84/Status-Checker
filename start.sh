cd ~/status-checker

while true; do
    echo "[$(date +"%d/%m/%Y %H:%M:%S")] Démarrage..." | tee -a logs.txt
    node index.js 2>&1 | tee -a logs.txt
    sleep 3
done
