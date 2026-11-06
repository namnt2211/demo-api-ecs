# demo-api — MVP Web API trên AWS (ECS Fargate + RDS + Secrets Manager)

API mẫu bằng Node.js/Express/TypeScript, kèm Terraform dựng hạ tầng AWS: VPC, Security Group, RDS (PostgreSQL), ECS Fargate, ALB, ECR, Secrets Manager.

## Kiến trúc

```
Internet
   │
   ▼
 ALB (public subnet, SG: 80 từ 0.0.0.0/0)
   │
   ▼
 ECS Fargate task (public subnet, public IP, SG: port 3000 chỉ từ ALB SG)
   │
   ▼
 RDS PostgreSQL (private subnet, SG: 5432 chỉ từ ECS SG)
```

- **VPC**: 2 public subnet (ALB + ECS task) + 2 private subnet (RDS), 2 AZ.
- **ECS task** đặt ở public subnet với public IP để tránh chi phí NAT Gateway (phù hợp MVP). Production nên chuyển task vào private subnet + NAT Gateway hoặc VPC endpoints.
- **RDS**: bật `manage_master_user_password = true` → AWS tự tạo và quản lý secret (username/password) trong Secrets Manager, không có password nào nằm trong Terraform state hay code.
- **ECS task definition** inject `DB_USERNAME`/`DB_PASSWORD` trực tiếp từ Secrets Manager secret (qua `secrets` field, ECS agent tự lấy lúc container start — key không bao giờ nằm trong task definition dạng plaintext).
- **Security Group**: 3 lớp tách biệt (ALB → ECS → RDS), không SG nào mở cho toàn internet trừ ALB cổng 80.

## Cấu trúc project

```
src/                  # Express API (TypeScript)
Dockerfile
docker-compose.yml    # chạy local với Postgres
terraform/            # IaC toàn bộ hạ tầng AWS
scripts/push-to-ecr.sh
```

## API endpoints

- `GET /health` — kiểm tra kết nối DB
- `GET /items` — list
- `POST /items` — body `{ "name": "..." }`
- `GET /items/:id`
- `DELETE /items/:id`

## 1. Chạy thử local

Cần Docker.

```bash
docker compose up --build
curl http://localhost:3000/health
curl -X POST http://localhost:3000/items -H "Content-Type: application/json" -d "{\"name\":\"test\"}"
curl http://localhost:3000/items
```

## 2. Chuẩn bị trước khi deploy AWS

Cần cài: AWS CLI (đã `aws configure` với credentials có đủ quyền IAM/VPC/RDS/ECS/ECR/Secrets Manager), Docker, Terraform >= 1.5.

Kiểm tra:
```bash
aws sts get-caller-identity
terraform -version
docker -version
```

## 3. Tạo hạ tầng AWS bằng Terraform

Vì ECS task definition cần image đã tồn tại trong ECR, làm theo đúng thứ tự: tạo ECR repo trước, push image, rồi apply toàn bộ phần còn lại.

```bash
cd terraform
terraform init

# Bước 1: chỉ tạo ECR repo
terraform apply -target=aws_ecr_repository.app

cd ..
```

## 4. Build & push Docker image lên ECR

```bash
chmod +x scripts/push-to-ecr.sh
./scripts/push-to-ecr.sh latest
```

Script tự lấy repo URL + region từ terraform output, login, build, push.

## 5. Apply toàn bộ hạ tầng còn lại

```bash
cd terraform
terraform apply
```

Xem trước thay đổi bằng `terraform plan` nếu muốn kiểm tra kỹ. Lần apply này tạo VPC, subnet, SG, RDS, ALB, ECS cluster/service — mất khoảng 5-10 phút (RDS khởi tạo lâu nhất).

Sau khi xong, lấy output:
```bash
terraform output
```

Sẽ thấy `alb_dns_name`, `ecr_repository_url`, `rds_endpoint`, `db_secret_arn`.

## 6. Gọi thử API từ bên ngoài

```bash
ALB=$(terraform -chdir=terraform output -raw alb_dns_name)
curl http://$ALB/health
curl -X POST http://$ALB/items -H "Content-Type: application/json" -d "{\"name\":\"hello from aws\"}"
curl http://$ALB/items
```

Nếu `/health` trả `db_unreachable`, đợi thêm 1-2 phút để ECS task và RDS sẵn sàng hoàn toàn, hoặc xem log:
```bash
aws logs tail /ecs/demo-api --follow --region ap-southeast-1
```

## 7. Khi sửa code và cần deploy lại

```bash
./scripts/push-to-ecr.sh v2
```

Rồi cập nhật `image_tag` trong terraform (hoặc `-var image_tag=v2`) và apply lại, hoặc đơn giản hơn cho MVP: push lại tag `latest` rồi force new deployment:

```bash
aws ecs update-service --cluster demo-api-cluster --service demo-api-service --force-new-deployment --region ap-southeast-1
```

## 8. Dọn dẹp (tránh phát sinh chi phí)

```bash
cd terraform
terraform destroy
```

Kiểm tra kỹ output trước khi xác nhận — lệnh này xoá toàn bộ RDS/ECS/ALB/VPC đã tạo.

## Lưu ý chi phí & bảo mật (MVP vs Production)

- MVP này không dùng NAT Gateway (tiết kiệm ~1 triệu/tháng) bằng cách gán public IP trực tiếp cho ECS task. Production nên đưa task vào private subnet + NAT hoặc VPC endpoint (ECR, Secrets Manager, CloudWatch Logs) để task không có public IP.
- RDS `skip_final_snapshot = true` và `deletion_protection = false` để dễ `destroy` khi test — **bật lại cả hai khi dùng thật**.
- ALB chỉ nghe HTTP (80). Production cần thêm ACM certificate + listener HTTPS (443).
- Secrets Manager hiện chỉ chứa DB credentials (tự động qua RDS). Muốn thêm secret khác (API key, JWT secret...) tạo thêm `aws_secretsmanager_secret` + `aws_secretsmanager_secret_version`, rồi thêm vào `secrets` của container definition tương tự DB_PASSWORD.
