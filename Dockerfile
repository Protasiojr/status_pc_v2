FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=6001

RUN apk add --no-cache openssh-client iputils iproute2 nmap

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.js *.html *.css ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 6001
CMD ["node", "server.js"]
