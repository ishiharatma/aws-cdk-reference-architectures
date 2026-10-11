"""Glue ETL: raw CSV orders -> cleaned, typed, partitioned Parquet.

Reads the raw table from the Data Catalog, drops rows that cannot be trusted (no order id, non-positive amount or
quantity, unparsable timestamp), keeps one row per order id (the latest timestamp wins), derives the partition column
`order_date`, and writes Parquet partitioned by it. Only the partitions present in the input are replaced.
"""
import sys

from awsglue.context import GlueContext
from awsglue.job import Job
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from pyspark.sql import Window
from pyspark.sql import functions as F

args = getResolvedOptions(sys.argv, ["JOB_NAME", "source_database", "source_table", "target_path"])

spark_context = SparkContext()
glue_context = GlueContext(spark_context)
spark = glue_context.spark_session
# Replace only the partitions that are written, not the whole target.
spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")
job = Job(glue_context)
job.init(args["JOB_NAME"], args)

raw = glue_context.create_dynamic_frame.from_catalog(
    database=args["source_database"], table_name=args["source_table"]
).toDF()
raw_count = raw.count()

typed = (
    raw.select(
        F.col("order_id").cast("string").alias("order_id"),
        F.col("customer_id").cast("string").alias("customer_id"),
        F.col("product").cast("string").alias("product"),
        F.col("quantity").cast("int").alias("quantity"),
        F.col("amount").cast("decimal(12,2)").alias("amount"),
        F.to_timestamp("order_ts").alias("order_ts"),
    )
)

valid = typed.filter(
    F.col("order_id").isNotNull()
    & (F.length("order_id") > 0)
    & F.col("order_ts").isNotNull()
    & (F.col("quantity") > 0)
    & (F.col("amount") > 0)
)

# One row per order id; if an order was exported twice, the latest timestamp wins.
latest = Window.partitionBy("order_id").orderBy(F.col("order_ts").desc())
curated = (
    valid.withColumn("_rank", F.row_number().over(latest))
    .filter(F.col("_rank") == 1)
    .drop("_rank")
    .withColumn("order_date", F.to_date("order_ts"))
)

curated.write.mode("overwrite").partitionBy("order_date").parquet(args["target_path"])

print(f"raw rows: {raw_count}, curated rows: {curated.count()}")
job.commit()
