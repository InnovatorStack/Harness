var rules = this.getInnovator().applyMethod("ReadReviewRules", "");

if (rules.isError())
{
    return rules;
}

var update = this.newItem("ExampleReview", "edit");
update.setID(this.getProperty("review_id"));
update.setProperty("remark", this.getProperty("remark"));
update.setProperty("approved_on", this.getProperty("approved_on"));

return update.apply();
