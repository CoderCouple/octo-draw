# Serverless API on AWS
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "private" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24" # not a } brace issue
}

resource "aws_security_group" "lambda" {
  vpc_id = aws_vpc.main.id
}

resource "aws_iam_role" "lambda" {
  name               = "api-lambda"
  assume_role_policy = <<EOF2
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow" }] }
EOF2
}

resource "aws_lambda_function" "api" {
  function_name = "api-${var.env}"
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs20.x"
  vpc_config {
    subnet_ids         = [aws_subnet.private.id]
    security_group_ids = [aws_security_group.lambda.id]
  }
  environment {
    variables = {
      TABLE  = aws_dynamodb_table.orders.name
      QUEUE  = aws_sqs_queue.jobs.url
      BUCKET = "${aws_s3_bucket.uploads.bucket}"
    }
  }
}

resource "aws_dynamodb_table" "orders" {
  name     = "orders"
  hash_key = "id"
}

resource "aws_sqs_queue" "jobs" {
  name = "jobs"
}

resource "aws_s3_bucket" "uploads" {
  bucket = "acme-uploads"
}

resource "aws_apigatewayv2_api" "http" {
  name          = "api"
  protocol_type = "HTTP"
}

resource "aws_lambda_permission" "apigw" {
  function_name = aws_lambda_function.api.function_name
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_cloudfront_distribution" "cdn" {
  origin {
    domain_name = aws_s3_bucket.uploads.bucket_regional_domain_name
  }
  depends_on = [aws_s3_bucket.uploads]
}

/* resource "aws_instance" "commented_out" { } */

module "network" {
  source = "./modules/network"
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"
  vpc_id  = aws_vpc.main.id
}
