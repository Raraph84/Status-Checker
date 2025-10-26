FROM node:22

ENV TZ=Europe/Paris

ADD . /app
WORKDIR /app

RUN npm install --omit=dev

CMD ["node", "index.js"]
