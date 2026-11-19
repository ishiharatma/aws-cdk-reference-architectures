# Lambda-provided GPU base image (PyTorch + CUDA + Lambda runtime interface client).
# Pinned by digest so rebuilds are reproducible; refresh it deliberately.
FROM public.ecr.aws/lambda/deep-learning-containers/pytorch:cuda@sha256:b9521b1134f4e4c119241ad6ee48730a29523799325f9a13dec979dad6bed578

# Bake the ResNet-50 weights into the image. The base image points TORCH_HOME at /tmp,
# which is empty at runtime; the capacity provider subnets have no internet access,
# so the weights must already be in the image.
ENV TORCH_HOME=/opt/torch
RUN python -c "from torchvision.models import resnet50, ResNet50_Weights; resnet50(weights=ResNet50_Weights.IMAGENET1K_V2)" \
    && chmod -R a+rX /opt/torch

COPY handler.py ${LAMBDA_TASK_ROOT}/
CMD ["handler.handler"]
