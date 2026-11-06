# Deploy demo-api lên AWS qua Console (không dùng Terraform)

Hướng dẫn này dựng đúng kiến trúc như bản Terraform (`terraform/`) nhưng làm thủ công 100% qua AWS Console. Chỉ có **1 bước bắt buộc dùng CLI**: build & push Docker image lên ECR — console không làm được việc này.

Region dùng trong guide: `ap-southeast-1` (Singapore). Đổi region ở đâu thì nhớ đổi đồng bộ các bước.

## Kiến trúc (nhắc lại)

```
Internet → ALB (public subnet, SG mở 80) → ECS Fargate task (public subnet, SG chỉ nhận từ ALB SG)
                                                   → RDS PostgreSQL (private subnet, SG chỉ nhận từ ECS SG)
```

---

## 0. Chuẩn bị

- Tài khoản AWS, user/role có quyền: VPC, EC2 (SG, ALB), RDS, ECS, ECR, IAM, Secrets Manager, CloudWatch Logs.
- Cài Docker + AWS CLI local, đã `aws configure` (chỉ dùng để push image, không dùng để deploy hạ tầng).
- Code trong thư mục `src/`, `Dockerfile` đã có sẵn từ project này.

---

## 1. Tạo VPC + Subnet

Console: **VPC → Create VPC**

Chọn **"VPC and more"** (wizard tự tạo subnet + route table + IGW):

- Name tag auto-generate: `demo-api`
- IPv4 CIDR: `10.0.0.0/16`
- Number of Availability Zones: `2`
- Number of public subnets: `2`
- Number of private subnets: `2`
- NAT gateways: **None** (tránh phí NAT, ECS task sẽ chạy ở public subnet với public IP thay vì qua NAT)
- VPC endpoints: **None**
- DNS hostnames / DNS resolution: giữ mặc định (Enable)

Bấm **Create VPC**. Ghi nhớ tên 2 public subnet và 2 private subnet được tạo (vd `demo-api-subnet-public1-ap-southeast-1a`, `...private1...`).

---

## 2. Tạo Security Groups

Console: **EC2 → Security Groups → Create security group**. Cả 3 đều chọn VPC `demo-api-vpc` vừa tạo.

### 2.1 `demo-api-alb-sg`
- Inbound: HTTP (80), Source: `0.0.0.0/0`
- Outbound: để mặc định (All traffic)

### 2.2 `demo-api-ecs-sg`
- Inbound: Custom TCP, port `3000`, Source: chọn **Security group** = `demo-api-alb-sg`
- Outbound: mặc định

### 2.3 `demo-api-rds-sg`
- Inbound: PostgreSQL (5432), Source: chọn **Security group** = `demo-api-ecs-sg`
- Outbound: mặc định

---

## 3. Tạo RDS PostgreSQL

Console: **RDS → Databases → Create database**

- Choose a database creation method: **Standard create**
- Engine: **PostgreSQL**, version 16.x
- Templates: **Dev/Test** (hoặc Free tier nếu đủ điều kiện)
- Settings:
  - DB instance identifier: `demo-api-db`
  - Master username: `demoapi_admin`
  - **Credentials management: chọn "Manage master credentials in AWS Secrets Manager"** ✅ (tick ô này — AWS tự sinh password, tự tạo secret trong Secrets Manager, bạn không cần tự nghĩ/lưu password ở đâu cả)
- Instance configuration: Burstable classes → `db.t4g.micro`
- Storage: 20 GiB, gp3, tắt storage autoscaling (không cần cho MVP)
- Connectivity:
  - Virtual private cloud: `demo-api-vpc`
  - DB subnet group: **Create new** (nó sẽ dùng các subnet của VPC — nhớ chọn đúng 2 **private** subnet nếu được hỏi, hoặc vào sửa DB subnet group sau khi tạo)
  - Public access: **No**
  - VPC security group: **Choose existing** → chọn `demo-api-rds-sg` (bỏ chọn `default`)
- Additional configuration:
  - Initial database name: `demoapi`
  - Backup: tuỳ chọn, MVP có thể tắt để đỡ phí
  - **Enable deletion protection: bỏ tick** (để dễ xoá khi dọn dẹp)

Bấm **Create database**. Đợi status chuyển **Available** (~5-10 phút).

Sau khi tạo xong, lấy 2 thông tin quan trọng:

1. **Endpoint**: vào DB instance `demo-api-db` → tab **Connectivity & security** → copy **Endpoint** (vd `demo-api-db.xxxxx.ap-southeast-1.rds.amazonaws.com`).
2. **Secret ARN**: cùng trang, mục **Master credentials ARN** → bấm vào link, hoặc vào **Secrets Manager → Secrets**, tìm secret tên dạng `rds!db-xxxxxxxx-xxxx...` → copy **Secret ARN**. Giữ lại, dùng ở bước 6.

---

## 4. Tạo ECR repository + push image

Console: **ECR → Repositories → Create repository**

- Visibility: Private
- Repository name: `demo-api`
- Scan on push: tuỳ chọn (bật cũng được)

Bấm **Create repository**. Sau khi tạo, chọn repo → bấm **View push commands** (AWS tự sinh đúng lệnh cho bạn, gồm login/build/tag/push). Chạy local:

```bash
aws ecr get-login-password --region ap-southeast-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.ap-southeast-1.amazonaws.com

docker build -t demo-api .
docker tag demo-api:latest <account-id>.dkr.ecr.ap-southeast-1.amazonaws.com/demo-api:latest
docker push <account-id>.dkr.ecr.ap-southeast-1.amazonaws.com/demo-api:latest
```

Ghi nhớ **Image URI** đầy đủ (`<account-id>.dkr.ecr.ap-southeast-1.amazonaws.com/demo-api:latest`), dùng ở bước 6.

---

## 5. Tạo ECS Cluster

Console: **ECS → Clusters → Create cluster**

- Cluster name: `demo-api-cluster`
- Infrastructure: **AWS Fargate (serverless)** (mặc định)

Bấm **Create**.

---

## 6. Tạo Task Definition

Console: **ECS → Task definitions → Create new task definition**

- Task definition family: `demo-api-task`
- Launch type: **AWS Fargate**
- Operating system/Architecture: Linux/X86_64
- CPU: `.25 vCPU`, Memory: `0.5 GB`
- Task role: None
- Task execution role: **Create new role** (AWS tự tạo `ecsTaskExecutionRole` với quyền pull ECR + ghi log — sẽ bổ sung quyền đọc secret ở bước 6.2)

**Container - 1:**
- Name: `app`
- Image URI: dán Image URI từ bước 4 (`...dkr.ecr.../demo-api:latest`)
- Port mappings: Container port `3000`, Protocol TCP
- Environment variables (type: Value):
  | Key | Value |
  |---|---|
  | PORT | 3000 |
  | DB_HOST | *(endpoint RDS từ bước 3)* |
  | DB_PORT | 5432 |
  | DB_NAME | demoapi |
  | DB_SSL | true |
- Secrets (type: **ValueFrom**) — đây là phần dùng Secrets Manager, **không gõ password tay**:
  | Key | Value from |
  |---|---|
  | DB_USERNAME | `<secret-arn-tu-buoc-3>:username::` |
  | DB_PASSWORD | `<secret-arn-tu-buoc-3>:password::` |

  (Secret của RDS là JSON `{"username":"...","password":"..."}`, cú pháp `secretArn:jsonKey::` lấy đúng field đó.)

- Logging: tick **Use log collection** → CloudWatch, auto-configure (tự tạo log group `/ecs/demo-api-task`).

Bấm **Create**.

### 6.2 Cấp quyền đọc secret cho execution role

Role `ecsTaskExecutionRole` vừa tạo **chưa** có quyền đọc secret của RDS. Vào:

**IAM → Roles → tìm `ecsTaskExecutionRole`** → tab Permissions → **Add permissions → Create inline policy** → tab JSON, dán:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "<secret-arn-tu-buoc-3>"
    }
  ]
}
```

Đặt tên policy `demo-api-read-db-secret` → **Create policy**.

Thiếu bước này, ECS task sẽ fail start với lỗi `ResourceInitializationError` khi lấy secret.

---

## 7. Tạo Target Group + Application Load Balancer

### 7.1 Target Group

**EC2 → Target Groups → Create target group**

- Target type: **IP addresses**
- Target group name: `demo-api-tg`
- Protocol: HTTP, Port: `3000`
- VPC: `demo-api-vpc`
- Health check path: `/health`

Bấm **Next** → **Create target group** (chưa cần register target thủ công, ECS service sẽ tự đăng ký).

### 7.2 Application Load Balancer

**EC2 → Load Balancers → Create load balancer → Application Load Balancer**

- Name: `demo-api-alb`
- Scheme: **Internet-facing**
- VPC: `demo-api-vpc`, chọn 2 **public** subnet
- Security groups: `demo-api-alb-sg` (bỏ `default`)
- Listeners: HTTP : 80 → forward to `demo-api-tg`

Bấm **Create load balancer**.

---

## 8. Tạo ECS Service

Vào cluster `demo-api-cluster` → tab **Services** → **Create**

- Launch type: **Fargate**
- Task definition: `demo-api-task` (latest revision)
- Service name: `demo-api-service`
- Desired tasks: `1`
- Networking:
  - VPC: `demo-api-vpc`
  - Subnets: chọn 2 **public** subnet
  - Security group: chọn existing → `demo-api-ecs-sg`
  - Public IP: **Turned on** (bắt buộc — vì không có NAT, task cần public IP để pull image ECR)
- Load balancing: **Application Load Balancer**
  - Chọn ALB có sẵn: `demo-api-alb`
  - Container to load balance: `app:3000`
  - Target group: chọn existing → `demo-api-tg`

Bấm **Create**. Đợi vài phút, task chuyển **RUNNING** và target group hiện **healthy**.

---

## 9. Test từ bên ngoài

Lấy DNS name: **EC2 → Load Balancers → `demo-api-alb`** → copy **DNS name**.

```bash
ALB=<dns-name-cua-alb>

curl http://$ALB/health
curl -X POST http://$ALB/items -H "Content-Type: application/json" -d "{\"name\":\"hello\"}"
curl http://$ALB/items
```

Nếu `/health` báo `db_unreachable`: kiểm tra target group health check (tab Target groups → Health status), security group RDS có đúng cho phép từ `ecs-sg` không, và xem CloudWatch log group `/ecs/demo-api-task`.

---

## 10. Redeploy khi sửa code

```bash
docker build -t demo-api .
docker tag demo-api:latest <account-id>.dkr.ecr.ap-southeast-1.amazonaws.com/demo-api:latest
docker push <account-id>.dkr.ecr.ap-southeast-1.amazonaws.com/demo-api:latest
```

Vào **ECS → cluster → service `demo-api-service`** → **Update service** → tick **Force new deployment** → Update. (Nếu image tag vẫn `latest`, không cần tạo task definition revision mới.)

---

## 11. Dọn dẹp (tránh phát sinh phí)

Xoá theo đúng thứ tự để tránh lỗi "resource đang được dùng":

1. **ECS Service**: cluster → service → **Delete** (set desired count về 0 trước nếu được hỏi)
2. **ECS Cluster**: `demo-api-cluster` → Delete
3. **Task definition**: không bắt buộc xoá (không tốn phí), có thể **Deregister** nếu muốn sạch
4. **Load Balancer**: `demo-api-alb` → Delete
5. **Target Group**: `demo-api-tg` → Delete
6. **RDS instance**: `demo-api-db` → Actions → Delete (tick "I acknowledge... skip final snapshot" vì đã tắt deletion protection)
7. **Secrets Manager secret**: secret `rds!db-...` thường tự xoá kèm RDS, nếu còn → Actions → Delete, chọn "Schedule deletion" hoặc force delete ngay
8. **ECR repository**: `demo-api` → Delete (xoá luôn image bên trong)
9. **Security groups**: xoá theo thứ tự ngược phụ thuộc — `demo-api-rds-sg` trước (vì ecs-sg được reference), rồi `demo-api-ecs-sg`, cuối cùng `demo-api-alb-sg`
10. **VPC**: `demo-api-vpc` → Delete VPC (sẽ xoá kèm subnet, route table, IGW)

---

## So sánh với bản Terraform

Guide này tạo **cùng kiến trúc** với `terraform/` trong project — cùng tên resource logic (ALB/ECS/RDS SG 3 lớp, RDS managed secret, ECS task inject secret trực tiếp). Khác biệt: làm tay từng bước, không có state file, không `terraform destroy` một lệnh — nên bước dọn dẹp (mục 11) phải làm thủ công đúng thứ tự như trên.
