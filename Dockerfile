FROM node:lts-alpine

RUN apk add --no-cache git

WORKDIR /app

RUN git clone https://github.com/spocel/revertclash.git .

RUN npm install

RUN cp clash-urls.txt.example clash-urls.txt

EXPOSE 3000

CMD ["npm", "run", "start"]
