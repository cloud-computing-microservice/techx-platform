variable "REGISTRY" { default = "techx" }
variable "IMAGE_TAG" { default = "local" }
variable "REVISION" { default = "local" }

group "default" {
  targets = ["frontend", "catalog", "order"]
}

target "_common" {
  context = "."
  platforms = ["linux/amd64"]
  args = { REVISION = REVISION }
  attest = ["type=provenance,disabled=true"]
}

target "frontend" {
  inherits = ["_common"]
  dockerfile = "src/frontend/Dockerfile"
  tags = ["${REGISTRY}/frontend:${IMAGE_TAG}"]
}

target "catalog" {
  inherits = ["_common"]
  dockerfile = "src/catalog-api/Dockerfile"
  tags = ["${REGISTRY}/catalog:${IMAGE_TAG}"]
}

target "order" {
  inherits = ["_common"]
  dockerfile = "src/order-api/Dockerfile"
  tags = ["${REGISTRY}/order:${IMAGE_TAG}"]
}
