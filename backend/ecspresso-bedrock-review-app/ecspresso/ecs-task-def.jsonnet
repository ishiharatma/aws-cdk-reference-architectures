// ECS task definition (jsonnet version). CPU/memory, the ECR image URI, and
// the IAM role ARNs are injected from the CodeBuild (Deploy stage) environment.

local env = std.native('env');
local must_env = std.native('must_env');

local project = must_env('PROJECT');
local envName = must_env('ENV');
local containerName = '%s-%s-api' % [project, envName];

{
  family: containerName,
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  cpu: env('TASK_CPU', '256'),
  memory: env('TASK_MEMORY', '512'),
  executionRoleArn: must_env('EXECUTION_ROLE_ARN'),
  taskRoleArn: must_env('TASK_ROLE_ARN'),
  containerDefinitions: [
    {
      name: containerName,
      image: '%s:%s' % [must_env('ECR_REPO_URI'), env('IMAGE_TAG', 'latest')],
      essential: true,
      portMappings: [
        { containerPort: 8080, protocol: 'tcp' },
      ],
      environment: [
        { name: 'NODE_ENV', value: envName },
        { name: 'PORT', value: '8080' },
      ],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': '/ecs/%s' % containerName,
          'awslogs-region': env('AWS_REGION', 'ap-northeast-1'),
          'awslogs-stream-prefix': 'ecs',
        },
      },
      healthCheck: {
        command: [
          'CMD-SHELL',
          "node -e \"require('http').get('http://localhost:8080/health',(r)=>{process.exit(r.statusCode===200?0:1)})\"",
        ],
        interval: 30,
        timeout: 5,
        retries: 3,
        startPeriod: 10,
      },
    },
  ],
}
