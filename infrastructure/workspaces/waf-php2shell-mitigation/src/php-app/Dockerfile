# PHP-FPM + nginx on AWS Lambda through the Lambda Web Adapter (LWA).
#
# The origin runs a PATCHED PHP release (8.4.27 fixes CVE-2026-109618 / CVE-2026-109619).
# It exists only so that requests the WAF lets through reach a real PHP-FPM worker with the
# server-side mitigations applied; it is never meant to be exploitable.
FROM public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1 AS adapter

FROM php:8.4.27-fpm-alpine3.24

# LWA runs as a Lambda extension: it polls the Runtime API and proxies each event to :8080.
COPY --from=adapter /lambda-adapter /opt/extensions/lambda-adapter

RUN apk add --no-cache nginx

COPY nginx.conf /etc/nginx/nginx.conf
COPY php-fpm-pool.conf /usr/local/etc/php-fpm.d/zz-php2shell.conf
COPY php.ini /usr/local/etc/php/conf.d/zz-php2shell.ini
COPY public/ /var/www/html/
COPY run.sh /run.sh
RUN chmod 0755 /run.sh

ENV AWS_LWA_PORT=8080 \
    AWS_LWA_READINESS_CHECK_PATH=/health \
    AWS_LWA_READINESS_CHECK_HEALTHY_STATUS=200

ENTRYPOINT ["/run.sh"]
