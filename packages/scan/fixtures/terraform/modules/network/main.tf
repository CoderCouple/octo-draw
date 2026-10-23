resource "aws_route53_zone" "primary" {
  name = "example.com"
}

resource "aws_lb" "public" {
  name = "public"
}
