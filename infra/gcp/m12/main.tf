# M12 deployment skeleton. Applying this file creates no resources while
# enable_paid_resources stays false. Do not set it true from this milestone.

variable "enable_paid_resources" {
  type        = bool
  description = "Must stay false until an operator explicitly approves paid GCP resources."
  default     = false
}

variable "project_id" {
  type        = string
  description = "GCP project id. Unused while paid resources are disabled."
  default     = ""
}

variable "region" {
  type    = string
  default = "northamerica-northeast1"
}

locals {
  department_services = jsondecode(file("${path.module}/services.json"))
}

output "department_service_count" {
  value = length(local.department_services)
}

output "paid_resources_enabled" {
  value = var.enable_paid_resources
}

# Placeholder so a future operator can attach one dedicated serving process
# per department. count is zero until enable_paid_resources is true, and this
# milestone does not run terraform apply.
resource "terraform_data" "dedicated_serving_intent" {
  count = var.enable_paid_resources ? length(local.department_services) : 0
  input = local.department_services[count.index]
}
