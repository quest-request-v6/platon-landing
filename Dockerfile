FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.html favicon.svg server.js demo.webm robots.txt sitemap.xml ./
EXPOSE 80
CMD ["node", "server.js"]
