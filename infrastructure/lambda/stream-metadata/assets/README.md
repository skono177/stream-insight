# RDS CA bundle

`global-bundle.pem` is the AWS RDS global certificate bundle used to verify the Aurora PostgreSQL TLS certificate and endpoint hostname.

Source: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

The bundle is stored with the source and copied into the Lambda artifact during CDK bundling. Runtime or deployment-time download is not required.
