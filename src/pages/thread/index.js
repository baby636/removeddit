import React from 'react'
import { Link } from 'react-router-dom'
import {
  getPost,
  getComments as getRedditComments,
  chunkSize as redditChunkSize
} from '../../api/reddit'
import {
  getPost as getPushshiftPost,
  getComments as getPushshiftComments
} from '../../api/pushshift'
import { isDeleted, isRemoved, sleep } from '../../utils'
import { connect, constrainMaxComments } from '../../state'
import Post from '../common/Post'
import CommentSection from './CommentSection'
import SortBy from './SortBy'
import CommentInfo from './CommentInfo'
import LoadMore from './LoadMore'

// A FIFO queue with items pushed in individually, and shifted out in an Array of chunkSize
class ChunkedQueue {

  constructor(chunkSize) {
    if (!(chunkSize > 0))
      throw RangeError('chunkSize must be > 0')
    this._chunkSize = chunkSize
    this._chunks = [[]]  // Array of Arrays
    // Invariant: this._chunks always contains at least one Array
  }

  push(x) {
    const last = this._chunks[this._chunks.length - 1]
    if (last.length < this._chunkSize)
      last.push(x)
    else
      this._chunks.push([x])
  }

  hasFullChunk = () => this._chunks[0].length >= this._chunkSize * 0.9
  isEmpty      = () => this._chunks[0].length == 0

  shiftChunk() {
    const first = this._chunks.shift()
    if (this._chunks.length == 0)
      this._chunks.push([])
    return first
  }
}

class Thread extends React.Component {
  state = {
    post: {},
    pushshiftCommentLookup: new Map(),
    removed: 0,
    deleted: 0,
    loadedAllComments: false,
    loadingComments: true,
    reloadingComments: false
  }

  componentDidMount () {
    const { subreddit, threadID } = this.props.match.params
    this.props.global.setLoading('Loading post...')

    // Get post from reddit
    getPost(threadID)
      .then(post => {
        let edited_selftext
        document.title = post.title
        if (isDeleted(post.selftext))
          post.deleted = true
        else if (isRemoved(post.selftext) || post.removed_by_category)
          post.removed = true
        else if (post.edited) {
          edited_selftext = post.selftext
          post.selftext = '...'  // temporarily remove it to avoid flashing it onscreen
        }
        this.setState({ post })
        // Fetch the post from Pushshift if it was deleted/removed/edited
        if (post.deleted || post.removed || post.edited) {
          getPushshiftPost(threadID)
            .then(origPost => {
              if (origPost) {
                if (post.deleted || post.removed) {  // use the post from Pushshift instead
                  origPost.score = post.score
                  origPost.num_comments = post.num_comments
                  origPost.edited = post.edited
                  if (post.deleted)
                    origPost.deleted = true
                  else
                    origPost.removed = true
                  this.setState({ post: origPost })
                } else {  // it was only edited - update (if necessary) and use the Reddit post
                  if (edited_selftext != origPost.selftext && !isRemoved(origPost.selftext)) {
                    post.selftext = origPost.selftext
                    post.edited_selftext = edited_selftext
                  }
                  this.setState({ post })
                }
              } else if (post.edited) {
                post.selftext = edited_selftext  // restore it (after temporarily removing it above)
                this.setState({ post })
              }
            })
            .catch(e => {
              this.props.global.setError(e, e.helpUrl)
              if (post.edited) {
                post.selftext = edited_selftext
                this.setState({ post })
              }
            })
        }
      })
      .catch(error => {
        this.props.global.setError(error)
        // Fetch the post from pushshift on other errors (e.g. posts from banned subreddits)
        getPushshiftPost(threadID)
          .then(removedPost => {
            document.title = removedPost.title
            this.setState({ post: { ...removedPost, removed: true } })
          })
          .catch(error => {
            this.props.global.setError(error, error.helpUrl)
            // Create a dummy post so that comments will still be displayed
            this.setState({ post: { subreddit, id: threadID } })
          })
      })
      .finally(() => {
        if (this.state.loadingComments)
          this.props.global.setLoading('Loading comments from Pushshift...')
      })

    const maxCommentsQuery = constrainMaxComments(
      parseInt((new URLSearchParams(this.props.location.search)).get('max_comments')))
    this.getComments(Math.max(this.props.global.maxComments, maxCommentsQuery), 0)
  }

  componentDidUpdate () {
    const { loadingMoreComments } = this.props.global.state
    if (loadingMoreComments) {
      this.props.global.state.loadingMoreComments = 0
      this.setState({reloadingComments: true})
      this.props.global.setLoading('Loading more comments from Pushshift...')
      this.getComments(loadingMoreComments, this.lastCreatedUtc - 1)
    }
  }

  getComments (newCommentCount, after) {
    const { threadID } = this.props.match.params
    const { pushshiftCommentLookup } = this.state
    const redditIdQueue = new ChunkedQueue(redditChunkSize)
    const pushshiftPromises = [], redditPromises = []
    let redditError = false, doRedditComments

    // Process a chunk of comments downloaded from Pushshift (started below)
    const processPushshiftComments = comments => {
      pushshiftPromises.push(sleep(0).then(() => {
        let count = 0
        comments.forEach(comment => {
          const { id, parent_id } = comment
          if (!pushshiftCommentLookup.has(id)) {
            pushshiftCommentLookup.set(id, comment)
            redditIdQueue.push(id)
            count++
            if (parent_id != threadID && !pushshiftCommentLookup.has(parent_id)) {
              pushshiftCommentLookup.set(parent_id, undefined)
              redditIdQueue.push(parent_id)
            }
          }
        })
        while (redditIdQueue.hasFullChunk())
          doRedditComments(redditIdQueue.shiftChunk())
        return count
      }))
      return redditError  // causes getPushshiftComments() to exit early on a Reddit error
    }

    // Download a list of comments by id from Reddit, and process them
    doRedditComments = ids => redditPromises.push(getRedditComments(ids)
      .then(comments => {
        comments.forEach(comment => {
          let pushshiftComment = pushshiftCommentLookup.get(comment.id)
          if (pushshiftComment === undefined) {
            // When a parent comment is missing from pushshift, use the reddit comment instead
            comment.parent_id = comment.parent_id.substring(3)
            comment.link_id = comment.link_id.substring(3)
            pushshiftComment = comment
            pushshiftCommentLookup.set(comment.id, pushshiftComment)
          } else {
            // Replace pushshift score with reddit (it's usually more accurate)
            pushshiftComment.score = comment.score
          }

          // Check what is removed / deleted according to reddit
          if (isRemoved(comment.body)) {
            this.state.removed++
            pushshiftComment.removed = true
          } else if (isDeleted(comment.body)) {
            this.state.deleted++
            pushshiftComment.deleted = true
          } else if (pushshiftComment !== comment) {
            if (isRemoved(pushshiftComment.body)) {
              // If it's deleted in pushshift, but later restored by a mod, use the restored
              comment.parent_id = comment.parent_id.substring(3)
              comment.link_id = comment.link_id.substring(3)
              pushshiftCommentLookup.set(comment.id, comment)
            } else if (pushshiftComment.body != comment.body) {
              pushshiftComment.edited_body = comment.body
              pushshiftComment.edited = comment.edited
            }
          }
        })
        return comments.length
      })
      .catch(error => {
        this.props.global.setError(error, error.helpUrl)
        redditError = true
      })
    )

    // Download comments from Pushshift, and process each chunk (above) as it's retrieved
    getPushshiftComments(processPushshiftComments, threadID, newCommentCount, after)
      .then(([lastCreatedUtc, loadedAllComments]) => {
        this.lastCreatedUtc = lastCreatedUtc
        if (redditError)
          return
        this.props.global.setLoading('Comparing comments to Reddit API...')

        // All comments have been retrieved from Pushshift; wait for processing to finish
        Promise.all(pushshiftPromises).then(lengths => {
          console.log('Pushshift:', lengths.reduce((a,b) => a+b, 0), 'comments')

          // All comments from Pushshift have been processed; wait for Reddit to finish
          while (!redditIdQueue.isEmpty())
            doRedditComments(redditIdQueue.shiftChunk())
          Promise.all(redditPromises).then(lengths => {
            console.log('Reddit:', lengths.reduce((a,b) => a+b, 0), 'comments')
            if (!redditError) {
              this.props.global.setSuccess()
              this.setState({
                pushshiftCommentLookup,
                removed: this.state.removed,
                deleted: this.state.deleted,
                loadedAllComments,
                loadingComments: false,
                reloadingComments: false
              })
            }
          })
        })
      })
      .catch(e => this.props.global.setError(e, e.helpUrl))
  }

  render () {
    const { subreddit, id, author } = this.state.post
    const { commentID } = this.props.match.params
    const reloadingComments = this.state.reloadingComments || this.props.global.state.loadingMoreComments
    const linkToRestOfComments = `/r/${subreddit}/comments/${id}/_/`

    const isSingleComment = commentID !== undefined
    const root = isSingleComment ? commentID : id

    return (
      <>
        <Post {...this.state.post} />
        {
          (!this.state.loadingComments && root) &&
          <>
            <CommentInfo
              total={this.state.pushshiftCommentLookup.size}
              removed={this.state.removed}
              deleted={this.state.deleted}
            />
            <SortBy
              loadedAllComments={this.state.loadedAllComments}
              reloadingComments={reloadingComments}
              total={this.state.pushshiftCommentLookup.size}
            />
            {isSingleComment &&
              <div className='view-rest-of-comment'>
                <div>you are viewing a single comment's thread.</div>
                <Link to={linkToRestOfComments}>view the rest of the comments</Link>
              </div>
            }
            <CommentSection
              root={root}
              comments={this.state.pushshiftCommentLookup}
              postAuthor={isDeleted(author) ? null : author}
              commentFilter={this.props.global.state.commentFilter}  // need to explicitly
              commentSort={this.props.global.state.commentSort}      // pass in these props
              reloadingComments={reloadingComments}                  // to ensure React.memo
              total={this.state.pushshiftCommentLookup.size}         // works correctly
            />
            <LoadMore
              loadedAllComments={this.state.loadedAllComments}
              reloadingComments={reloadingComments}
              total={this.state.pushshiftCommentLookup.size}
            />
          </>
        }
      </>
    )
  }
}

export default connect(Thread)
