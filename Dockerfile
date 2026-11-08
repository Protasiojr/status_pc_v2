FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=6001

COPY package.json ./
COPY *.js *.html *.css ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 6001
CMD ["node", "server.js"]
