FROM node:22

ENV TZ=Europe/Paris

WORKDIR /app

COPY package.json package-lock.json /app
RUN npm install --omit=dev

COPY tsconfig.json index.ts /app
COPY src /app/src
RUN npm run build

CMD ["node", "index.js"]
