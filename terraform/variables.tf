variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "ap-southeast-1"
}

variable "project_name" {
  description = "Name prefix for all resources"
  type        = string
  default     = "demo-api"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.11.0/24", "10.0.12.0/24"]
}

variable "db_name" {
  type    = string
  default = "demoapi"
}

variable "db_username" {
  type    = string
  default = "demoapi_admin"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "container_port" {
  type    = number
  default = 3000
}

variable "ecs_cpu" {
  type    = string
  default = "256"
}

variable "ecs_memory" {
  type    = string
  default = "512"
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "image_tag" {
  description = "Tag of the image in ECR to deploy"
  type        = string
  default     = "latest"
}
