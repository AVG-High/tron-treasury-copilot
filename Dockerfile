FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4187
USER node
EXPOSE 4187
CMD ["npm", "start"]
