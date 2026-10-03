# AWS Lambda Web Functions — Status and API Surface

As of 2026-10-03, Lambda Web Functions is **not available to external customers**. It is
documented only as a boto3 service reference, and that reference states the API is
experimental and for internal AWS use only. No architecture in this repository uses it.

Source: [boto3 reference — Lambda Web Functions (`lambda-web`)](https://docs.aws.amazon.com/boto3/latest/reference/services/lambda-web.html)

## What it is

A service for running a web application or API as an HTTP server on Lambda and exposing it
through an HTTPS endpoint. The boto3 client name is `lambda-web`.

| Concept | Description |
| ------- | ----------- |
| Web Function | The web application deployed on Lambda |
| Revision | An immutable version of code and configuration |
| Endpoint | The HTTPS URL that exposes a Web Function |
| Resource policy | Resource-based access control attached to the Web Function |

## API operations

- Web Function: `CreateWebFunction`, `GetWebFunction`, `DeleteWebFunction`, `ListWebFunctions`, `UpdateWebFunctionEndpoint`
- Revision: `CreateWebFunctionRevision`, `GetWebFunctionRevision`, `DeleteWebFunctionRevision`, `ListWebFunctionRevisions`
- Endpoint: `CreateWebFunctionEndpoint`, `GetWebFunctionEndpoint`, `DeleteWebFunctionEndpoint`, `ListWebFunctionEndpoints`
- Resource policy: `PutResourcePolicy`, `GetResourcePolicy`, `DeleteResourcePolicy`
- Tags and settings: `TagResource`, `UntagResource`, `ListTags`, `GetWebAccountSettings`
- Waiters: `WebFunctionActive`, `WebFunctionDeleted`, `WebFunctionEndpointActive`, `WebFunctionEndpointDeleted`, `WebFunctionEndpointUpdated`, `WebFunctionRevisionActive`

## Not yet known

- CloudFormation resource types and CDK constructs
- Developer Guide, pricing, quotas, supported runtimes and packaging
- Differences from Function URL + Lambda Web Adapter and from Lambda MicroVMs ([lambda-microvms.md](lambda-microvms.md))

## When it becomes available

Check the CloudFormation and CDK support first, then compare against the existing options
above. Deploy-verify before adding an architecture (see
[deploy-verification-workflow.md](deploy-verification-workflow.md)).
