# syntax=docker/dockerfile:1

# companion.moxxy.ai. The site is plain HTML, CSS and one small script, so there
# is no build stage and nothing to bundle: the image is nginx plus six files.
FROM nginx:1.27-alpine

# Replace the packaged default server rather than adding a second one, or both
# match `server_name _` on port 8080 and the first one loaded wins.
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/companion-landing.conf
COPY site/ /usr/share/nginx/html/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
