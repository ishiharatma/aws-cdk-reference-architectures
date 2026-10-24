# BuildReport Lambda. cairosvg (SVG -> PNG) needs the native cairo library,
# which is why this function is a container image rather than a zip.
FROM public.ecr.aws/lambda/python:3.12

# cairo for cairosvg, a font so <text> renders in the PNG.
RUN dnf install -y cairo dejavu-sans-fonts && dnf clean all

COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt -t ${LAMBDA_TASK_ROOT}

COPY app/ ${LAMBDA_TASK_ROOT}/app/

CMD ["app.handler.handler"]
