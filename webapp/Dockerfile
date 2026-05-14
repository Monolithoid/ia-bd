FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js .

# Pré-créer le dossier sessions avec le bon propriétaire.
# Quand le volume host est monté, ses permissions priment ;
# ce RUN sert de fallback (dev local sans volume).
RUN mkdir -p /data/sessions /data/projects /data/renders \
 && chown node:node /data/sessions /data/projects /data/renders

USER node
CMD ["node", "server.js"]
