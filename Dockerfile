FROM node:20-alpine

RUN apk add --no-cache ffmpeg chromium nss freetype harfbuzz ca-certificates ttf-freefont

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
