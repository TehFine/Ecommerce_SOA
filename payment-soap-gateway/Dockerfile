FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js payment.wsdl ./
EXPOSE 3004
CMD ["node","server.js"]
