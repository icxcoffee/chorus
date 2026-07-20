# Queue Migration

The service will switch all producers to the new queue in one deployment. Consumers will be updated afterwards. The plan does not define rollback criteria, compatibility during mixed deployment, or ownership for failed messages.
