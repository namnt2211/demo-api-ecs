output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "aws_region" {
  value = var.aws_region
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "rds_endpoint" {
  value = aws_db_instance.main.address
}

output "db_secret_arn" {
  description = "Secrets Manager secret ARN holding the RDS master username/password"
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}
