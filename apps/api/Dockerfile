FROM node:22-alpine AS web-build
WORKDIR /app/apps/web
COPY apps/web/package*.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY apps/api/package*.json ./apps/api/
RUN npm --prefix apps/api ci --omit=dev
COPY apps/api/ ./apps/api/
COPY data/demo.csv ./data/demo.csv
COPY scripts/ ./scripts/
COPY --from=web-build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
CMD ["npm", "--prefix", "apps/api", "start"]
