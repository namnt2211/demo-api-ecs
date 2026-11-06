resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db-subnet-group"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${var.project_name}-db-subnet-group" }
}

# manage_master_user_password = true makes RDS create and manage a Secrets Manager
# secret for the master password automatically (no password handled in Terraform state).
resource "aws_db_instance" "main" {
  identifier                  = "${var.project_name}-db"
  engine                      = "postgres"
  engine_version              = "16"
  instance_class              = var.db_instance_class
  allocated_storage           = 20
  db_name                     = var.db_name
  username                    = var.db_username
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az                = false
  skip_final_snapshot     = true
  deletion_protection     = false

  tags = { Name = "${var.project_name}-db" }
}
