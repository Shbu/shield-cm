# SHIELD AI Crisis Management

Generates a ransomware crisis-management playbook response from a short incident summary. A user describes the incident in a web UI; AWS Bedrock maps it to playbook triggers, and the app returns the matching stakeholders, roles, communications and external notifications, plus suggested next steps.

## Components
The system consists of below components

* User Interface/UX
* Application Program Interface/Service to interact with UI
* API talks to Lambda function
* Requests are passed to AWS Bedrock model
* Dynamo DB to save requests, invites etc

